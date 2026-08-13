param(
    [string]$SourceIcon = "src-tauri\icons\source-icon.png",
    [string]$OutDir = "src-tauri\icons"
)
$ErrorActionPreference = "Stop"

# Resolve the source icon path relative to the project root.
$source = Resolve-Path $SourceIcon -ErrorAction Stop

# Ensure Node dependencies (including @tauri-apps/cli) are available.
if (-not (Test-Path "node_modules")) {
    Write-Output "Installing dependencies..."
    npm install | Out-Null
}

# Use the Tauri CLI to generate the full standard icon set.
# This populates src-tauri/icons with Windows, Android, iOS and macOS assets.
npm exec tauri icon "$source"

# The Tauri generator does not produce a dedicated tray icon or the legacy
# app-icon.png used elsewhere in the project, so we render those from the same
# source to keep the visual identity consistent.
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($source)

function Resize-Icon($img, $size, $path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $g.DrawImage($img, 0, 0, $size, $size)
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "generated: $path"
}

Resize-Icon $img 64 (Join-Path $OutDir "tray.png")
Resize-Icon $img 512 (Join-Path $OutDir "app-icon.png")

$img.Dispose()
Write-Output "icon generation complete"
