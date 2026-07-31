using System;
using System.Security.Principal;
using System.Web;

namespace IisProxyAuth
{
    /// <summary>
    /// IIS managed HTTP module that stamps the IIS-authenticated Windows user into the
    /// X-Windows-User request header BEFORE the request is reverse-proxied (ARR) to the
    /// Next.js backend on 127.0.0.1.
    ///
    /// Why a module (not a URL Rewrite {LOGON_USER} serverVariable): URL Rewrite runs at
    /// BeginRequest, before Windows auth completes, so {LOGON_USER} is empty there.
    /// PostAuthenticateRequest runs AFTER auth, so the identity is available.
    /// (Requires ASP.NET / .NET Extensibility installed, or no managed code runs at all.)
    ///
    /// Security: the header is CLEARED first (destroying any value a client tried to send)
    /// and only re-set from the server-side authenticated principal. Combined with the
    /// Node backend listening on 127.0.0.1 only, the backend can fully trust this header.
    /// </summary>
    public class WindowsUserHeaderModule : IHttpModule
    {
        private const string HeaderName = "X-Windows-User";

        public void Init(HttpApplication application)
        {
            application.PostAuthenticateRequest += OnPostAuthenticate;
        }

        public void Dispose() { }

        private void OnPostAuthenticate(object sender, EventArgs e)
        {
            HttpApplication app = (HttpApplication)sender;

            // Anti-spoofing: always destroy any client-supplied copy first.
            app.Request.Headers.Set(HeaderName, "");

            WindowsIdentity id = null;
            try { id = app.Request.LogonUserIdentity; } catch { }

            if (id != null && id.IsAuthenticated && !string.IsNullOrEmpty(id.Name))
            {
                app.Request.Headers.Set(HeaderName, id.Name); // e.g. "TELMACO\\jdoe"
            }
        }
    }
}
