<%@ LANGUAGE="VBScript" %>
<%
Response.ContentType = "text/plain"
Dim userName
userName = Request.ServerVariables("LOGON_USER")
If IsNull(userName) Or Len(Trim(userName)) = 0 Then
  userName = Request.ServerVariables("REMOTE_USER")
End If
If IsNull(userName) Or Len(Trim(userName)) = 0 Then
  userName = Request.ServerVariables("AUTH_USER")
End If
Response.Write Trim(userName)
%>
