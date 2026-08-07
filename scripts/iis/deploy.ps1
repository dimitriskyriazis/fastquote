#Requires -RunAsAdministrator
<#
  FastQuote production deploy.
  Run via deploy.bat (which elevates and calls this with -File).

  Flow: maintenance gate ON -> pull -> stop Node -> set the previous build aside
  -> install + build -> start Node -> gate OFF. While the gate file exists, the IIS
  "Maintenance Mode" rewrite rule serves maintenance.html for every request, so users
  never hit the half-deployed / stopped backend.

  ROLLBACK: `next build` overwrites .next in place, so a failed build used to destroy
  the running build with no way back. We now rename .next to .next.prev before building
  and restore it (plus the previous commit and its node_modules) if anything fails, so a
  failed deploy ends with the site LIVE on the previous build rather than down.
  Cost: every build is cold, since the Turbopack build cache lives under .next.
#>

# --- Paths -------------------------------------------------------------------
$AppRoot  = 'C:\fastquote'                 # Node app + git repo (PM2 runs from here)
$SiteRoot = 'C:\apps\fastquote\wwwroot'    # IIS site physical path (web.config + maintenance.html live here).
$AppPool  = 'fastquote'                     # IIS application pool name (IIS Manager > Application Pools).
$Flag     = Join-Path $SiteRoot 'maintenance.flag'
$Dist     = Join-Path $AppRoot '.next'
$DistPrev = Join-Path $AppRoot '.next.prev'
$Ecosystem = Join-Path $AppRoot 'ecosystem.config.cjs'

Import-Module WebAdministration -ErrorAction SilentlyContinue

# Commit the site is running right now. Captured before `git pull` so it is a real
# rollback target; printed on every failure path so recovery never needs archaeology.
$PreSha = ''

function Bring-SiteUp {
  pm2 delete fastquote 2>$null | Out-Null
  pm2 start $Ecosystem
  if ($LASTEXITCODE -ne 0) { return $false }
  pm2 save | Out-Null
  if (Test-Path $Flag) { Remove-Item $Flag -Force }
  # IIS kernel/output-caches the maintenance.html response, so deleting the flag alone is NOT
  # enough - the site stays stuck on the maintenance page until the app pool is recycled.
  Restart-WebAppPool -Name $AppPool
  return $true
}

# Failure AFTER the previous build was set aside: put everything back and come up on it.
function Fail-WithRollback($msg) {
  Write-Host ''
  Write-Host "DEPLOY FAILED: $msg" -ForegroundColor Red
  Write-Host "Rolling back to $PreSha ..." -ForegroundColor Yellow

  if (Test-Path $Dist) { Remove-Item $Dist -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $DistPrev) { Rename-Item $DistPrev '.next' -ErrorAction SilentlyContinue }

  git reset --hard $PreSha
  npm ci

  if ((Test-Path $Dist) -and (Bring-SiteUp)) {
    Write-Host ''
    Write-Host "Rolled back. Site is LIVE on the previous build ($PreSha)." -ForegroundColor Green
    Write-Host 'The deploy did NOT apply. Fix the problem and re-run.' -ForegroundColor Yellow
    exit 1
  }

  Write-Host ''
  Write-Host 'ROLLBACK ALSO FAILED - THE SITE IS DOWN AND STILL IN MAINTENANCE MODE.' -ForegroundColor Red
  Write-Host 'Recover by hand, in this order:' -ForegroundColor Yellow
  Write-Host "  cd $AppRoot" -ForegroundColor Yellow
  Write-Host "  git reset --hard $PreSha" -ForegroundColor Yellow
  Write-Host '  npm ci' -ForegroundColor Yellow
  Write-Host '  npm run build' -ForegroundColor Yellow
  Write-Host "  pm2 start $Ecosystem" -ForegroundColor Yellow
  Write-Host "  Restart-WebAppPool -Name $AppPool" -ForegroundColor Yellow
  Write-Host "  Remove-Item '$Flag' -Force" -ForegroundColor Yellow
  exit 1
}

# Failure BEFORE anything was touched: nothing to undo, site is still serving.
function Fail-Early($msg) {
  Write-Host ''
  Write-Host "DEPLOY ABORTED: $msg" -ForegroundColor Red
  Write-Host 'Nothing was changed - the site is still running the current build.' -ForegroundColor Yellow
  Write-Host "Taking it out of maintenance mode." -ForegroundColor Yellow
  if (Test-Path $Flag) { Remove-Item $Flag -Force }
  Restart-WebAppPool -Name $AppPool
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
if (-not (Test-Path $Ecosystem)) {
  Write-Host "ecosystem.config.cjs not found at $Ecosystem - PM2 could not be restarted after the build." -ForegroundColor Red
  exit 1
}

Set-Location $AppRoot

# A leftover .next.prev means the last deploy died mid-flight. Refuse to overwrite the
# only surviving copy of a known-good build - the operator must look at it first.
if (Test-Path $DistPrev) {
  Write-Host "'$DistPrev' already exists - a previous deploy did not finish cleanly." -ForegroundColor Red
  Write-Host 'Inspect it, then delete or restore it before deploying again.' -ForegroundColor Yellow
  exit 1
}

$PreSha = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $PreSha) {
  Write-Host "Could not read the current commit in $AppRoot - is it a git checkout?" -ForegroundColor Red
  exit 1
}
Write-Host "Current build is at $PreSha" -ForegroundColor Cyan

# --- 1) Maintenance ON --------------------------------------------------------
New-Item -ItemType File $Flag -Force | Out-Null
Write-Host "Maintenance mode ON  ($Flag)" -ForegroundColor Cyan

# --- 2) Pull (still serving the old build; nothing destroyed yet) -------------
git pull
if ($LASTEXITCODE -ne 0) { Fail-Early 'git pull failed (dirty working tree or network).' }

# --- 3) Stop Node, then set the previous build aside -------------------------
# Node must be stopped first: a running `next start` holds handles under .next, and
# Windows will not let us rename the directory out from under it.
pm2 stop fastquote 2>$null | Out-Null
if (Test-Path $Dist) {
  Rename-Item $Dist '.next.prev' -ErrorAction SilentlyContinue
  if (Test-Path $Dist) { Fail-WithRollback 'could not set .next aside (file still locked - is another node.exe running?).' }
}

# --- 4) Install + build ------------------------------------------------------
# npm ci, not npm install: the lockfile is authoritative, so prod can never silently
# re-resolve a dependency (the caret range on next admits a newer minor than the lock).
npm ci
if ($LASTEXITCODE -ne 0) { Fail-WithRollback 'npm ci failed.' }

npm run build
if ($LASTEXITCODE -ne 0) { Fail-WithRollback 'next build failed.' }

# --- 5) Start Node + maintenance OFF -----------------------------------------
if (-not (Bring-SiteUp)) { Fail-WithRollback 'pm2 start failed.' }

# --- 6) Only now is the previous build expendable ----------------------------
Remove-Item $DistPrev -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'Deploy complete - maintenance mode OFF, Node is live.' -ForegroundColor Green
Write-Host "  was: $PreSha" -ForegroundColor DarkGray
Write-Host "  now: $((git rev-parse HEAD).Trim())" -ForegroundColor DarkGray
Write-Host 'Smoke-test: load the site, then check GET /api/health returns 200.' -ForegroundColor Cyan
