using System;
using System.IO;
using System.Text;
using System.Web;

namespace SampleSite
{
    public sealed class SamplePages : IHttpHandler
    {
        public bool IsReusable => true;

        public void ProcessRequest(HttpContext context)
        {
            var request = context.Request;
            var response = context.Response;
            response.AppendHeader("x-origin", "1");
            var path = request.Path;
            if (request.HttpMethod == "POST" && path == "/ask")
            {
                using (var reader = new StreamReader(request.InputStream, Encoding.UTF8))
                {
                    var body = reader.ReadToEnd();
                    response.ContentType = "text/plain";
                    response.Write("ask-origin:" + Encoding.UTF8.GetByteCount(body));
                }
                return;
            }
            if (request.HttpMethod == "POST" && path == "/form")
            {
                response.ContentType = "text/plain";
                response.Write("form:" + request.Form["name"]);
                return;
            }
            response.ContentType = "text/html; charset=utf-8";
            if (path == "/cached")
            {
                response.Cache.SetCacheability(HttpCacheability.Public);
                response.Cache.SetExpires(DateTime.Now.AddMinutes(10));
                response.Cache.SetMaxAge(TimeSpan.FromMinutes(10));
                response.Cache.SetValidUntilExpires(true);
            }
            response.Write("<!doctype html><title>origin</title><h1>origin " + HttpUtility.HtmlEncode(path) + "</h1>");
        }
    }
}
