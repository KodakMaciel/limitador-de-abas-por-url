# Script PowerShell: Gerar ícones PNG para a extensão
# Usa System.Drawing nativo do Windows (sem dependências)

Add-Type -AssemblyName System.Drawing

# Diretório de saída, relativo a este script — assim o script funciona em
# qualquer máquina, sem depender de onde o projeto foi clonado.
$iconDir = Join-Path $PSScriptRoot "icons"
if (-not (Test-Path $iconDir)) {
  New-Item -ItemType Directory -Path $iconDir | Out-Null
}

# Tamanhos dos ícones
$sizes = @(16, 32, 48, 128)

foreach ($size in $sizes) {
  # Cria bitmap
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

  # Fundo azul escuro
  $blue = [System.Drawing.Color]::FromArgb(13, 71, 161)  # #0d47a1
  $graphics.Clear($blue)

  # Desenha "L" em branco (para tamanhos maiores)
  if ($size -ge 32) {
    $fontSize = [float]($size * 0.6)
    $font = New-Object System.Drawing.Font('Arial', $fontSize, [System.Drawing.FontStyle]::Bold)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $stringFormat = New-Object System.Drawing.StringFormat
    $stringFormat.Alignment = [System.Drawing.StringAlignment]::Center
    $stringFormat.LineAlignment = [System.Drawing.StringAlignment]::Center

    $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $graphics.DrawString('L', $font, $brush, $rect, $stringFormat)

    $font.Dispose()
    $brush.Dispose()
  }

  # Salva PNG
  $path = Join-Path $iconDir "icon$($size).png"
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host "Criado: $path"

  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-Host "Ícones gerados com sucesso!"
