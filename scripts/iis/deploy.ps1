#Requires -RunAsAdministrator
<#
  FastQuote production deploy.
  Run via deploy.bat (which elevates and calls this with -File).

  Flow: turn on the maintenance gate -> pull + install + build (stop at first failure)
  -> restart Node under PM2 -> turn off the maintenance gate. While the gate file exists,
  the IIS "Maintenance Mode" rewrite rule serves maintenance.html for every request, so
  users never hit the half-deployed / stopped backend.
#>

# --- Paths -------------------------------------------------------------------
$AppRoot  = 'C:\fastquote'                 # Node app + git repo (PM2 runs from here)
$SiteRoot = 'C:\apps\fastquote\wwwroot'    # IIS site physical path (web.config + maintenance.html live here).
$AppPool  = 'fastquote'                     # IIS application pool name (IIS Manager > Application Pools).
$Flag = Join-Path $SiteRoot 'maintenance.flag'

Import-Module WebAdministration -ErrorAction SilentlyContinue

function Fail($msg) {
  Write-Host ''
  Write-Host "DEPLOY ABORTED: $msg" -ForegroundColor Red
  Write-Host "Site is STILL in maintenance mode. Fix the problem and re-run," -ForegroundColor Yellow
  Write-Host "or delete '$Flag' to bring the site back up on the previous build." -ForegroundColor Yellow
  exit 1
}

# --- Sanity checks (before we change anything) -------------------------------
if (-not (Test-Path $SiteRoot)) {
  Write-Host "SiteRoot '$SiteRoot' not found - edit the `$SiteRoot variable in this script to your IIS site physical path." -ForegroundColor Red
  exit 1
}
if (-not (Test-Path (Join-Path $SiteRoot 'maintenance.html'))) {
  Write-Host "WARNING: maintenance.html not found in $SiteRoot - the maintenance page will 404 while the gate is on." -ForegroundColor Yellow
}

# 1) Maintenance ON ------------------------------------------------------------
New-Item -ItemType File $Flag -Force | Out-Null
Write-Host "Maintenance mode ON  ($Flag)" -ForegroundColor Cyan

# 2) Pull + build (each native step must succeed before the next) -------------
Set-Location $AppRoot
pm2 delete fastquote                        # ok if it wasn't running
git pull;      if ($LASTEXITCODE -ne 0) { Fail 'git pull failed (dirty working tree or network).' }
npm install;   if ($LASTEXITCODE -ne 0) { Fail 'npm install failed.' }
npm run build; if ($LASTEXITCODE -ne 0) { Fail 'next build failed - not starting; previous build stays.' }

# 3) Start Node ---------------------------------------------------------------
pm2 start (Join-Path $AppRoot 'ecosystem.config.cjs'); if ($LASTEXITCODE -ne 0) { Fail 'pm2 start failed.' }
pm2 save

# 4) Maintenance OFF ----------------------------------------------------------
Remove-Item $Flag -Force
# IIS kernel/output-caches the maintenance.html response, so deleting the flag alone is NOT
# enough - the site stays stuck on the maintenance page until the app pool is recycled.
# Recycling flushes the cache; IIS then proxies straight to the (now-live) Node backend.
Restart-WebAppPool -Name $AppPool
Write-Host ''
Write-Host 'Deploy complete - maintenance mode OFF, Node is live.' -ForegroundColor Green
