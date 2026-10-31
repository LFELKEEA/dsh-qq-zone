param([Parameter(Mandatory = $true)][string]$Path, [double]$Scale = 2.0)

# Windows 内置 OCR（WinRT Windows.Media.Ocr）：只认字，不懂画面。
# 不能用 [Windows.Storage.StorageFile]::GetFileFromPathAsync —— 在这台机器上它必抛
# "使用 1 个参数调用 Wait 时发生异常"；改成 ReadAllBytes + InMemoryRandomAccessStream 就稳。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataWriter, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapTransform, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

try {
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not [System.IO.File]::Exists($full)) { [Console]::Error.WriteLine("FILE_NOT_FOUND: $full"); exit 2 }
  $bytes = [System.IO.File]::ReadAllBytes($full)
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter($stream.GetOutputStreamAt(0))
  $writer.WriteBytes($bytes)
  Await ($writer.StoreAsync()) ([uint32]) | Out-Null
  $writer.DetachStream() | Out-Null
  $stream.Seek(0) | Out-Null

  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $scale = $Scale
  if ($scale -le 0) { $scale = 1.0 }
  $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
  $transform.ScaledWidth = [uint32][math]::Round($decoder.PixelWidth * $scale)
  $transform.ScaledHeight = [uint32][math]::Round($decoder.PixelHeight * $scale)
  $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
    [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
    [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
    $transform,
    [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
    [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
  )) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $lang = New-Object Windows.Globalization.Language 'zh-Hans-CN'
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine) { [Console]::Error.WriteLine('ENGINE_UNAVAILABLE: 系统没装可用的 OCR 语言包'); exit 3 }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($line in $result.Lines) { if ($line.Text.Trim().Length -gt 0) { $lines += $line.Text.Trim() } }
  [Console]::Out.WriteLine(($lines -join "`n"))
  exit 0
} catch {
  [Console]::Error.WriteLine("OCR_FAILED: $($_.Exception.Message)")
  exit 1
}