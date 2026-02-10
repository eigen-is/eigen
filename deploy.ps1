#!/usr/bin/env pwsh

param(
    [switch]$Local
)

$ErrorActionPreference = "Stop"

if ($Local) {
    Write-Host "🏠 Local Docker Testing Mode" -ForegroundColor Cyan
    Write-Host "=============================" -ForegroundColor Cyan
    Write-Host ""
    
    # Backup current .env and use .env.docker.local
    if (Test-Path .env) {
        Copy-Item .env .env.backup -Force
    }
    if (Test-Path .env.docker.local) {
        Copy-Item .env.docker.local .env -Force
    }
} else {
    Write-Host "🚀 Eigen Docker Deployment (Production)" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
}

# Build locally
Write-Host "Step 1: Building applications locally..." -ForegroundColor Yellow
bun run build:prod

# Build Docker images
Write-Host ""
Write-Host "Step 2: Building Docker images..." -ForegroundColor Yellow
docker compose build

# Start containers
Write-Host ""
Write-Host "Step 3: Starting containers..." -ForegroundColor Yellow
docker compose up -d

# Wait for services to be healthy
Write-Host ""
Write-Host "⏳ Waiting for services to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# Show status
Write-Host ""
Write-Host "📊 Container status:" -ForegroundColor Green
docker compose ps

Write-Host ""
Write-Host "✅ Deployment complete!" -ForegroundColor Green
Write-Host ""
Write-Host "🌐 Access your applications at:" -ForegroundColor Cyan
Write-Host "   - Home: http://localhost/"
Write-Host "   - Admin: http://localhost/admin"
Write-Host "   - Mail: http://localhost/mail"
Write-Host "   - Contacts: http://localhost/contacts"
Write-Host "   - Calendar: http://localhost/calendar"
Write-Host "   - Drive: http://localhost/drive"
Write-Host "   - Docs: http://localhost/docs"
Write-Host "   - Stickies: http://localhost/stickies"
Write-Host "   - Space: http://localhost/space"
Write-Host ""
Write-Host "📝 View logs: docker compose logs -f" -ForegroundColor Yellow
Write-Host "🛑 Stop: docker compose down" -ForegroundColor Yellow

# Restore .env if local mode
if ($Local) {
    Write-Host ""
    Write-Host "🔄 Restoring original .env..." -ForegroundColor Yellow
    if (Test-Path .env.backup) {
        Move-Item .env.backup .env -Force
    }
}
