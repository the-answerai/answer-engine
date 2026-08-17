$ErrorActionPreference = 'Stop'
$Version = '1.1.0'
$Tag = "v$Version"
$ReleaseBase = "https://github.com/the-answerai/answer-engine/releases/download/$Tag"
$BashAsset = "answer-engine-bootstrap-v$Version.sh"
$BashExpected = 'c1e65b8943709ede0109b2af566f72fd3b97d311261f44df6e64cf136db304bb'

if ($ReleaseBase -match '/(latest|heads|master|main)/') {
  throw 'Refusing a floating release input.'
}
if ([Environment]::OSVersion.Version.Build -lt 22000) {
  throw 'Windows 11 build 22000 or newer is required.'
}
if ([Environment]::Is64BitOperatingSystem -ne $true) {
  throw 'The supported Windows 11/WSL2 bootstrap requires x64 Windows.'
}

$WslStatus = & wsl.exe --status 2>&1
if ($LASTEXITCODE -ne 0) {
  throw 'WSL2 is required. Follow Microsoft Windows 11 WSL installation instructions, restart, and rerun this command.'
}

$Temporary = Join-Path ([IO.Path]::GetTempPath()) ("answer-engine-bootstrap-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Temporary | Out-Null
try {
  foreach ($Asset in @('SHA256SUMS', $BashAsset)) {
    Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/$Asset" -OutFile (Join-Path $Temporary $Asset)
  }
  $ChecksumLine = Get-Content (Join-Path $Temporary 'SHA256SUMS') |
    Where-Object { $_ -match "^[a-f0-9]{64}\s+\*?$([regex]::Escape($BashAsset))$" } |
    Select-Object -First 1
  if (-not $ChecksumLine -or ($ChecksumLine -split '\s+')[0] -ne $BashExpected) {
    throw "Release checksum does not match the pinned $BashAsset checksum."
  }
  $Expected = ($ChecksumLine -split '\s+')[0]
  $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Temporary $BashAsset)).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw "Checksum mismatch for $BashAsset. Refusing execution." }
  $WslPath = (& wsl.exe wslpath -a ($Temporary -replace '\\', '/')).Trim()
  & wsl.exe bash "$WslPath/$BashAsset" @args
  if ($LASTEXITCODE -ne 0) { throw 'The verified WSL2 bootstrap did not complete.' }
} finally {
  Remove-Item -LiteralPath $Temporary -Recurse -Force -ErrorAction SilentlyContinue
}
