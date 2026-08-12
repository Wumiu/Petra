param(
    [string]$OutDir = "src-tauri\icons"
)
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"

function New-BlobIcon($size, $path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $cx = $size / 2
    $cy = $size / 2
    $r = $size * 0.36

    # body
    $bodyBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 210, 230, 255))
    $g.FillEllipse($bodyBrush, $cx - $r, $cy - $r, $r * 2, $r * 2)
    # ears
    $earPts = @(
        (New-Object System.Drawing.PointF(($cx - $r * 1.05), ($cy - $r * 1.05))),
        (New-Object System.Drawing.PointF(($cx - $r * 0.35), ($cy - $r * 0.55))),
        (New-Object System.Drawing.PointF(($cx - $r * 0.6), ($cy - $r * 1.15)))
    )
    $g.FillPolygon($bodyBrush, $earPts)
    $earPts2 = @(
        (New-Object System.Drawing.PointF(($cx + $r * 1.05), ($cy - $r * 1.05))),
        (New-Object System.Drawing.PointF(($cx + $r * 0.35), ($cy - $r * 0.55))),
        (New-Object System.Drawing.PointF(($cx + $r * 0.6), ($cy - $r * 1.15)))
    )
    $g.FillPolygon($bodyBrush, $earPts2)
    # eyes
    $eyeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 70, 45, 60))
    $er = $r * 0.14
    $g.FillEllipse($eyeBrush, $cx - $r * 0.5 - $er, $cy - $r * 0.35 - $er, $er * 2, $er * 2)
    $g.FillEllipse($eyeBrush, $cx + $r * 0.5 - $er, $cy - $r * 0.35 - $er, $er * 2, $er * 2)
    # mouth
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 70, 45, 60), [Math]::Max(1, $size * 0.04))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($pen, $cx - $r * 0.25, $cy + $r * 0.15, $r * 0.5, $r * 0.3, 20, 140)

    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "generated: $path"
}

$srcDir = Split-Path -Parent $OutDir
if ($srcDir -eq "" -or $srcDir -eq ".") { $srcDir = "." }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

New-BlobIcon 512 (Join-Path $OutDir "app-icon.png")
New-BlobIcon 128 (Join-Path $OutDir "tray.png")