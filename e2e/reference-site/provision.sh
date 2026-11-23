#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-milan-waniwani}"
REGION="${AWS_REGION:-eu-west-3}"
NAME="relay-reference"
HERE="$(cd "$(dirname "$0")" && pwd)"
aws() { command aws --profile "$PROFILE" --region "$REGION" "$@"; }

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="$NAME-$ACCOUNT-$REGION"

if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
	aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
	aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
	aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{"Rules":[{"ID":"expire-builds","Status":"Enabled","Filter":{"Prefix":"builds/"},"Expiration":{"Days":30}}]}'
fi

for parameter in tunnel-credentials agent-traffic-key; do
	variable=$(echo "$parameter" | tr 'a-z-' 'A-Z_')
	if [[ -n "${!variable:-}" ]]; then
		aws ssm put-parameter --name "/$NAME/$parameter" --type SecureString --value "${!variable}" --overwrite >/dev/null
	elif [[ "$parameter" == tunnel-credentials ]] && ! aws ssm get-parameter --name "/$NAME/$parameter" >/dev/null 2>&1; then
		echo "Set $variable to store /$NAME/$parameter the first time" >&2
		exit 1
	fi
done

if ! aws iam get-role --role-name "$NAME" >/dev/null 2>&1; then
	aws iam create-role --role-name "$NAME" --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
	aws iam attach-role-policy --role-name "$NAME" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
	aws iam create-instance-profile --instance-profile-name "$NAME" >/dev/null
	aws iam add-role-to-instance-profile --instance-profile-name "$NAME" --role-name "$NAME"
	sleep 10
fi
aws iam put-role-policy --role-name "$NAME" --policy-name "$NAME" --policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"ssm:GetParameter","Resource":"arn:aws:ssm:$REGION:$ACCOUNT:parameter/$NAME/*"},
 {"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::$BUCKET/*"}
]}
JSON
)"

GITHUB_ROLE="$NAME-github"
OIDC="arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"
if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC" >/dev/null 2>&1; then
	aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com >/dev/null
fi
if ! aws iam get-role --role-name "$GITHUB_ROLE" >/dev/null 2>&1; then
	aws iam create-role --role-name "$GITHUB_ROLE" --assume-role-policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"$OIDC"},"Action":"sts:AssumeRoleWithWebIdentity",
 "Condition":{"StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"},
  "StringLike":{"token.actions.githubusercontent.com:sub":"repo:WaniWani-AI/relay:*"}}}]}
JSON
)" >/dev/null
fi
aws iam put-role-policy --role-name "$GITHUB_ROLE" --policy-name "$GITHUB_ROLE" --policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::$BUCKET/builds/*"},
 {"Effect":"Allow","Action":"ec2:DescribeInstances","Resource":"*"},
 {"Effect":"Allow","Action":"ssm:SendCommand","Resource":["arn:aws:ssm:$REGION::document/AWS-RunPowerShellScript"]},
 {"Effect":"Allow","Action":"ssm:SendCommand","Resource":"arn:aws:ec2:$REGION:$ACCOUNT:instance/*","Condition":{"StringEquals":{"aws:ResourceTag/Name":"$NAME"}}},
 {"Effect":"Allow","Action":["ssm:GetCommandInvocation","ssm:ListCommandInvocations"],"Resource":"*"}
]}
JSON
)"

VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
GROUP=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text)
if [[ "$GROUP" == "None" ]]; then
	GROUP=$(aws ec2 create-security-group --group-name "$NAME" --description "Relay reference site: outbound only" --vpc-id "$VPC" --query GroupId --output text)
fi

INSTANCE=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [[ "$INSTANCE" == "None" ]]; then
	AMI=$(aws ssm get-parameter --name /aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base --query Parameter.Value --output text)
	USER_DATA="$(mktemp)"
	{ echo "<powershell>"; sed "s/__BUCKET__/$BUCKET/; s/__REGION__/$REGION/" "$HERE/bootstrap.ps1"; echo "</powershell>"; } >"$USER_DATA"
	INSTANCE=$(aws ec2 run-instances \
		--image-id "$AMI" \
		--instance-type t3.medium \
		--iam-instance-profile Name="$NAME" \
		--security-group-ids "$GROUP" \
		--metadata-options HttpTokens=required,HttpEndpoint=enabled \
		--block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=60,VolumeType=gp3,Encrypted=true}' \
		--user-data "file://$USER_DATA" \
		--tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
		--query 'Instances[0].InstanceId' --output text)
	rm "$USER_DATA"
fi

echo "bucket=$BUCKET"
echo "instance=$INSTANCE"
echo "github_role=arn:aws:iam::$ACCOUNT:role/$GITHUB_ROLE"
