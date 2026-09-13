[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('npc', 'nps', 'all')]
    [string]$Mode = $(if ($env:NPS_INSTALL_MODE) { $env:NPS_INSTALL_MODE } else { 'all' }),

    [Parameter(Position = 1)]
    [string]$Version = $(if ($env:NPS_INSTALL_VERSION) { $env:NPS_INSTALL_VERSION } else { 'latest' }),

    [Parameter(Position = 2)]
    [string]$InstallDir = $env:NPS_INSTALL_DIR,

    [ValidateSet('auto', 'amd64', '386', 'arm64')]
    [string]$Arch = $(if ($env:NPS_INSTALL_ARCH) { $env:NPS_INSTALL_ARCH } else { 'auto' }),

    [ValidateSet('auto', 'modern', 'old')]
    [string]$PackageVariant = $(if ($env:NPS_INSTALL_VARIANT) { $env:NPS_INSTALL_VARIANT } else { 'auto' }),

    [switch]$Menu
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
}

function Write-Info {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Cyan
}

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Green
}

function Write-Notice {
    param([string]$Message)
    Write-Host "Note: $Message" -ForegroundColor Yellow
}

function Test-IsAdministrator {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-DefaultInstallDir {
    param([bool]$IsAdmin)

    if ($IsAdmin) {
        return 'C:\Program Files\nps'
    }

    if ($env:LOCALAPPDATA) {
        return (Join-Path $env:LOCALAPPDATA 'nps')
    }

    return (Join-Path $HOME 'nps')
}

function Get-DetectedArchitecture {
    $raw = $env:PROCESSOR_ARCHITEW6432
    if (-not $raw) {
        $raw = $env:PROCESSOR_ARCHITECTURE
    }
    if (-not $raw) {
        throw 'Unable to detect Windows architecture.'
    }

    switch ($raw.ToUpperInvariant()) {
        'AMD64' { return 'amd64' }
        'X86' { return '386' }
        'ARM64' { return 'arm64' }
        default { throw "Unsupported Windows architecture: $raw" }
    }
}

function Get-WindowsVersionInfo {
    $version = [Environment]::OSVersion.Version
    $label = "{0}.{1}.{2}" -f $version.Major, $version.Minor, $version.Build

    try {
        $registry = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
        if ($null -ne $registry.CurrentMajorVersionNumber) {
            $buildValue = 0
            if ($registry.CurrentBuild) {
                [void][int]::TryParse([string]$registry.CurrentBuild, [ref]$buildValue)
            }
            $version = New-Object Version -ArgumentList @([int]$registry.CurrentMajorVersionNumber, [int]$registry.CurrentMinorVersionNumber, $buildValue)
            $label = "{0}.{1}.{2}" -f $version.Major, $version.Minor, $version.Build
        } elseif ($registry.CurrentVersion) {
            $parsedVersion = New-Object Version ([string]$registry.CurrentVersion)
            $buildValue = 0
            if ($registry.CurrentBuildNumber) {
                [void][int]::TryParse([string]$registry.CurrentBuildNumber, [ref]$buildValue)
            }
            $version = New-Object Version -ArgumentList @($parsedVersion.Major, $parsedVersion.Minor, $buildValue)
            $label = "{0}.{1}.{2}" -f $version.Major, $version.Minor, $version.Build
        }
    } catch {
    }

    return @{
        Version = $version
        Label   = $label
    }
}

function Resolve-PackageVariant {
    param(
        [string]$RequestedVariant,
        [Version]$WindowsVersion
    )

    if ($RequestedVariant -eq 'modern' -or $RequestedVariant -eq 'old') {
        return $RequestedVariant
    }

    if ($WindowsVersion.Major -lt 10) {
        return 'old'
    }

    return 'modern'
}

function New-WebClient {
    $client = New-Object System.Net.WebClient
    $client.Headers['User-Agent'] = 'nps-install.ps1'
    $proxy = [System.Net.WebRequest]::GetSystemWebProxy()
    if ($proxy) {
        $proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
        $client.Proxy = $proxy
    }
    return $client
}

function Resolve-VersionInfo {
    param([string]$RequestedVersion)

    if ($RequestedVersion -and $RequestedVersion -ne 'latest') {
        return @{
            Version      = $RequestedVersion
            UseCdnLatest = $false
        }
    }

    $apiUrl = 'https://api.github.com/repos/djylb/nps/releases/latest'
    try {
        $client = New-WebClient
        $payload = $client.DownloadString($apiUrl)
        $release = $payload | ConvertFrom-Json
        $tagName = [string]$release.tag_name
        if ($tagName) {
            return @{
                Version      = $tagName
                UseCdnLatest = $false
            }
        }
    } catch {
        Write-Notice 'Failed to detect the latest release via GitHub API. CDN @latest fallback will be used.'
    }

    return @{
        Version      = 'latest'
        UseCdnLatest = $true
    }
}

function Get-AssetName {
    param(
        [string]$Component,
        [string]$ResolvedArch,
        [string]$ResolvedVariant
    )

    $suffix = switch ($Component) {
        'nps' { 'server' }
        'npc' { 'client' }
        default { throw "Unsupported component: $Component" }
    }

    if ($ResolvedVariant -eq 'old') {
        if ($ResolvedArch -notin @('amd64', '386')) {
            throw 'Old Windows release packages are only available for amd64 and 386.'
        }
        return "windows_{0}_{1}_old.tar.gz" -f $ResolvedArch, $suffix
    }

    return "windows_{0}_{1}.tar.gz" -f $ResolvedArch, $suffix
}

function Get-DownloadUrls {
    param(
        [string]$AssetName,
        [string]$ResolvedVersion,
        [bool]$UseCdnLatest
    )

    if ($UseCdnLatest) {
        return @(
            "https://cdn.jsdelivr.net/gh/djylb/nps-mirror@latest/$AssetName",
            "https://fastly.jsdelivr.net/gh/djylb/nps-mirror@latest/$AssetName",
            "https://github.com/djylb/nps/releases/latest/download/$AssetName",
            "https://gcore.jsdelivr.net/gh/djylb/nps-mirror@latest/$AssetName",
            "https://testingcf.jsdelivr.net/gh/djylb/nps-mirror@latest/$AssetName"
        )
    }

    return @(
        "https://github.com/djylb/nps/releases/download/$ResolvedVersion/$AssetName",
        "https://cdn.jsdelivr.net/gh/djylb/nps-mirror@$ResolvedVersion/$AssetName",
        "https://fastly.jsdelivr.net/gh/djylb/nps-mirror@$ResolvedVersion/$AssetName",
        "https://gcore.jsdelivr.net/gh/djylb/nps-mirror@$ResolvedVersion/$AssetName",
        "https://testingcf.jsdelivr.net/gh/djylb/nps-mirror@$ResolvedVersion/$AssetName"
    )
}

function Invoke-DownloadWithFallback {
    param(
        [string[]]$Urls,
        [string]$DestinationPath
    )

    $lastError = $null
    foreach ($url in $Urls) {
        Write-Info "Trying $url"
        try {
            $client = New-WebClient
            if (Test-Path -LiteralPath $DestinationPath) {
                Remove-Item -LiteralPath $DestinationPath -Force -ErrorAction SilentlyContinue
            }
            $client.DownloadFile($url, $DestinationPath)
            if ((Test-Path -LiteralPath $DestinationPath) -and ((Get-Item -LiteralPath $DestinationPath).Length -gt 0)) {
                return $url
            }
            throw "Downloaded file is empty: $DestinationPath"
        } catch {
            $lastError = $_
            Write-Notice $_.Exception.Message
            if (Test-Path -LiteralPath $DestinationPath) {
                Remove-Item -LiteralPath $DestinationPath -Force -ErrorAction SilentlyContinue
            }
        }
    }

    throw "Download failed for all mirrors. Last error: $($lastError.Exception.Message)"
}

function Read-ExactBytes {
    param(
        [System.IO.Stream]$Stream,
        [int]$Count
    )

    $buffer = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $read = $Stream.Read($buffer, $offset, $Count - $offset)
        if ($read -le 0) {
            throw 'Unexpected end of archive.'
        }
        $offset += $read
    }
    return $buffer
}

function Skip-ExactBytes {
    param(
        [System.IO.Stream]$Stream,
        [long]$Count
    )

    if ($Count -le 0) {
        return
    }

    $buffer = New-Object byte[] 65536
    $remaining = [long]$Count
    while ($remaining -gt 0) {
        $chunk = [Math]::Min($buffer.Length, [int]([Math]::Min($remaining, 65536)))
        $read = $Stream.Read($buffer, 0, $chunk)
        if ($read -le 0) {
            throw 'Unexpected end of archive while skipping bytes.'
        }
        $remaining -= $read
    }
}

function Get-TarText {
    param(
        [byte[]]$Buffer,
        [int]$Offset,
        [int]$Length
    )

    $text = [Text.Encoding]::ASCII.GetString($Buffer, $Offset, $Length)
    return $text.Trim([char]0, ' ')
}

function Get-TarEntrySize {
    param([byte[]]$Header)

    $raw = (Get-TarText -Buffer $Header -Offset 124 -Length 12).Trim()
    if (-not $raw) {
        return [int64]0
    }
    return [Convert]::ToInt64($raw, 8)
}

function Get-SafeDestinationPath {
    param(
        [string]$RootPath,
        [string]$RelativePath
    )

    $cleanRelativePath = ($RelativePath -replace '/', '\').TrimStart('\')
    $rootFullPath = [IO.Path]::GetFullPath($RootPath)
    $targetFullPath = [IO.Path]::GetFullPath((Join-Path $rootFullPath $cleanRelativePath))
    $rootPrefix = $rootFullPath.TrimEnd('\') + '\'

    if (($targetFullPath -ne $rootFullPath) -and (-not $targetFullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase))) {
        throw "Archive entry escapes the destination directory: $RelativePath"
    }

    return $targetFullPath
}

function Read-PaxHeaders {
    param([byte[]]$Data)

    $result = @{}
    $text = [Text.Encoding]::UTF8.GetString($Data)
    foreach ($line in ($text -split "`n")) {
        $line = $line.Trim()
        if (-not $line) {
            continue
        }
        $spaceIndex = $line.IndexOf(' ')
        if ($spaceIndex -lt 0) {
            continue
        }
        $record = $line.Substring($spaceIndex + 1)
        $equalsIndex = $record.IndexOf('=')
        if ($equalsIndex -lt 0) {
            continue
        }
        $key = $record.Substring(0, $equalsIndex)
        $value = $record.Substring($equalsIndex + 1)
        if ($key) {
            $result[$key] = $value
        }
    }
    return $result
}

function Read-EntryDataBytes {
    param(
        [System.IO.Stream]$Stream,
        [int64]$Size
    )

    if ($Size -lt 0) {
        throw 'Invalid tar entry size.'
    }
    if ($Size -gt [int64][int]::MaxValue) {
        throw 'Tar entry is too large for the PowerShell fallback extractor.'
    }

    $buffer = Read-ExactBytes -Stream $Stream -Count ([int]$Size)
    $padding = (512 - ($Size % 512)) % 512
    if ($padding -gt 0) {
        Skip-ExactBytes -Stream $Stream -Count $padding
    }
    return $buffer
}

function Expand-TarFileFallback {
    param(
        [string]$TarPath,
        [string]$DestinationPath
    )

    $rootFullPath = [IO.Path]::GetFullPath($DestinationPath)
    if (-not (Test-Path -LiteralPath $rootFullPath)) {
        New-Item -ItemType Directory -Path $rootFullPath -Force | Out-Null
    }

    $stream = [IO.File]::OpenRead($TarPath)
    try {
        $pendingPath = $null
        $pendingPax = @{}

        while ($true) {
            $header = Read-ExactBytes -Stream $stream -Count 512
            $allZero = $true
            foreach ($item in $header) {
                if ($item -ne 0) {
                    $allZero = $false
                    break
                }
            }
            if ($allZero) {
                break
            }

            $name = Get-TarText -Buffer $header -Offset 0 -Length 100
            $prefix = Get-TarText -Buffer $header -Offset 345 -Length 155
            if ($prefix) {
                $name = "$prefix/$name"
            }
            if ($pendingPath) {
                $name = $pendingPath
                $pendingPath = $null
            }
            if ($pendingPax.ContainsKey('path')) {
                $name = [string]$pendingPax['path']
            }

            $typeFlag = [char]$header[156]
            $size = Get-TarEntrySize -Header $header

            if ($typeFlag -eq 'x' -or $typeFlag -eq 'g') {
                $pendingPax = Read-PaxHeaders -Data (Read-EntryDataBytes -Stream $stream -Size $size)
                continue
            }

            if ($typeFlag -eq 'L') {
                $pendingPath = ([Text.Encoding]::ASCII.GetString((Read-EntryDataBytes -Stream $stream -Size $size))).Trim([char]0, [char]10, [char]13)
                continue
            }

            $pendingPax = @{}

            if (-not $name) {
                Skip-ExactBytes -Stream $stream -Count ($size + ((512 - ($size % 512)) % 512))
                continue
            }

            $targetPath = Get-SafeDestinationPath -RootPath $rootFullPath -RelativePath $name

            switch ($typeFlag) {
                '5' {
                    if (-not (Test-Path -LiteralPath $targetPath)) {
                        New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
                    }
                    continue
                }
                ([char]0) {
                    $parentPath = Split-Path -Path $targetPath -Parent
                    if ($parentPath -and (-not (Test-Path -LiteralPath $parentPath))) {
                        New-Item -ItemType Directory -Path $parentPath -Force | Out-Null
                    }
                    $fileStream = [IO.File]::Create($targetPath)
                    try {
                        $remaining = [int64]$size
                        $buffer = New-Object byte[] 65536
                        while ($remaining -gt 0) {
                            $chunk = [Math]::Min($buffer.Length, [int]([Math]::Min($remaining, 65536)))
                            $read = $stream.Read($buffer, 0, $chunk)
                            if ($read -le 0) {
                                throw 'Unexpected end of archive while extracting file content.'
                            }
                            $fileStream.Write($buffer, 0, $read)
                            $remaining -= $read
                        }
                    } finally {
                        $fileStream.Dispose()
                    }
                    $padding = (512 - ($size % 512)) % 512
                    if ($padding -gt 0) {
                        Skip-ExactBytes -Stream $stream -Count $padding
                    }
                    continue
                }
                '0' {
                    $parentPath = Split-Path -Path $targetPath -Parent
                    if ($parentPath -and (-not (Test-Path -LiteralPath $parentPath))) {
                        New-Item -ItemType Directory -Path $parentPath -Force | Out-Null
                    }
                    $fileStream = [IO.File]::Create($targetPath)
                    try {
                        $remaining = [int64]$size
                        $buffer = New-Object byte[] 65536
                        while ($remaining -gt 0) {
                            $chunk = [Math]::Min($buffer.Length, [int]([Math]::Min($remaining, 65536)))
                            $read = $stream.Read($buffer, 0, $chunk)
                            if ($read -le 0) {
                                throw 'Unexpected end of archive while extracting file content.'
                            }
                            $fileStream.Write($buffer, 0, $read)
                            $remaining -= $read
                        }
                    } finally {
                        $fileStream.Dispose()
                    }
                    $padding = (512 - ($size % 512)) % 512
                    if ($padding -gt 0) {
                        Skip-ExactBytes -Stream $stream -Count $padding
                    }
                    continue
                }
                default {
                    $skipLength = $size + ((512 - ($size % 512)) % 512)
                    Skip-ExactBytes -Stream $stream -Count $skipLength
                    continue
                }
            }
        }
    } finally {
        $stream.Dispose()
    }
}

function Expand-GzipFile {
    param(
        [string]$ArchivePath,
        [string]$TarPath
    )

    $inputStream = [IO.File]::OpenRead($ArchivePath)
    try {
        $gzipStream = New-Object IO.Compression.GzipStream($inputStream, [IO.Compression.CompressionMode]::Decompress)
        try {
            $outputStream = [IO.File]::Create($TarPath)
            try {
                $buffer = New-Object byte[] 65536
                while (($read = $gzipStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $outputStream.Write($buffer, 0, $read)
                }
            } finally {
                $outputStream.Dispose()
            }
        } finally {
            $gzipStream.Dispose()
        }
    } finally {
        $inputStream.Dispose()
    }
}

function Expand-TarGzArchive {
    param(
        [string]$ArchivePath,
        [string]$DestinationPath
    )

    if (Test-Path -LiteralPath $DestinationPath) {
        Remove-Item -LiteralPath $DestinationPath -Recurse -Force
    }
    New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null

    $tarCommand = Get-Command -Name tar -ErrorAction SilentlyContinue
    if ($tarCommand) {
        & $tarCommand.Source -xzf $ArchivePath -C $DestinationPath
        if ($LASTEXITCODE -eq 0) {
            return
        }
        Write-Notice 'Built-in tar extraction failed. Falling back to the PowerShell extractor.'
    }

    $tarPath = [IO.Path]::ChangeExtension($ArchivePath, '.tar')
    try {
        Expand-GzipFile -ArchivePath $ArchivePath -TarPath $tarPath
        Expand-TarFileFallback -TarPath $tarPath -DestinationPath $DestinationPath
    } finally {
        if (Test-Path -LiteralPath $tarPath) {
            Remove-Item -LiteralPath $tarPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Ensure-Directory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Copy-ConfigPreservingUserFile {
    param(
        [string]$SourcePath,
        [string]$TargetPath,
        [string]$DefaultPath
    )

    if (-not (Test-Path -LiteralPath $SourcePath)) {
        return
    }

    $targetDirectory = Split-Path -Path $TargetPath -Parent
    Ensure-Directory -Path $targetDirectory

    if (Test-Path -LiteralPath $TargetPath) {
        Copy-Item -LiteralPath $SourcePath -Destination $DefaultPath -Force
        return
    }

    Copy-Item -LiteralPath $SourcePath -Destination $TargetPath -Force
}

function Copy-IfMissing {
    param(
        [string]$SourcePath,
        [string]$TargetPath
    )

    if ((Test-Path -LiteralPath $SourcePath) -and (-not (Test-Path -LiteralPath $TargetPath))) {
        $targetDirectory = Split-Path -Path $TargetPath -Parent
        Ensure-Directory -Path $targetDirectory
        Copy-Item -LiteralPath $SourcePath -Destination $TargetPath -Force
    }
}

function Copy-DirectoryContents {
    param(
        [string]$SourcePath,
        [string]$TargetPath
    )

    if (-not (Test-Path -LiteralPath $SourcePath)) {
        return
    }

    Ensure-Directory -Path $TargetPath
    Get-ChildItem -LiteralPath $SourcePath -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $TargetPath -Recurse -Force
    }
}

function Install-NpsPackage {
    param(
        [string]$SourceRoot,
        [string]$TargetRoot
    )

    $exeSource = Join-Path $SourceRoot 'nps.exe'
    if (-not (Test-Path -LiteralPath $exeSource)) {
        throw "Missing nps.exe in extracted package: $SourceRoot"
    }

    Ensure-Directory -Path $TargetRoot
    Copy-Item -LiteralPath $exeSource -Destination (Join-Path $TargetRoot 'nps.exe') -Force

    $confDir = Join-Path $TargetRoot 'conf'
    Ensure-Directory -Path $confDir
    Copy-ConfigPreservingUserFile `
        -SourcePath (Join-Path $SourceRoot 'conf\nps.conf') `
        -TargetPath (Join-Path $confDir 'nps.conf') `
        -DefaultPath (Join-Path $confDir 'nps.conf.default')

    Copy-IfMissing `
        -SourcePath (Join-Path $SourceRoot 'conf\geoip.dat') `
        -TargetPath (Join-Path $confDir 'geoip.dat')
    Copy-IfMissing `
        -SourcePath (Join-Path $SourceRoot 'conf\geosite.dat') `
        -TargetPath (Join-Path $confDir 'geosite.dat')

    Copy-DirectoryContents -SourcePath (Join-Path $SourceRoot 'web') -TargetPath (Join-Path $TargetRoot 'web')
}

function Install-NpcPackage {
    param(
        [string]$SourceRoot,
        [string]$TargetRoot
    )

    $exeSource = Join-Path $SourceRoot 'npc.exe'
    if (-not (Test-Path -LiteralPath $exeSource)) {
        throw "Missing npc.exe in extracted package: $SourceRoot"
    }

    Ensure-Directory -Path $TargetRoot
    Copy-Item -LiteralPath $exeSource -Destination (Join-Path $TargetRoot 'npc.exe') -Force

    $confDir = Join-Path $TargetRoot 'conf'
    Ensure-Directory -Path $confDir
    Copy-ConfigPreservingUserFile `
        -SourcePath (Join-Path $SourceRoot 'conf\npc.conf') `
        -TargetPath (Join-Path $confDir 'npc.conf') `
        -DefaultPath (Join-Path $confDir 'npc.conf.default')

    Copy-IfMissing `
        -SourcePath (Join-Path $SourceRoot 'conf\multi_account.conf') `
        -TargetPath (Join-Path $confDir 'multi_account.conf')
}

function Read-MenuChoice {
    param(
        [string]$Prompt,
        [string[]]$Options,
        [string]$DefaultValue
    )

    while ($true) {
        Write-Host $Prompt
        for ($i = 0; $i -lt $Options.Length; $i++) {
            Write-Host ("  [{0}] {1}" -f ($i + 1), $Options[$i])
        }

        $defaultIndex = [Array]::IndexOf($Options, $DefaultValue)
        if ($defaultIndex -ge 0) {
            $inputValue = Read-Host ("Choose 1-{0} (default {1})" -f $Options.Length, ($defaultIndex + 1))
        } else {
            $inputValue = Read-Host ("Choose 1-{0}" -f $Options.Length)
        }

        if (-not $inputValue -and $DefaultValue) {
            return $DefaultValue
        }

        [int]$numericValue = 0
        if ([int]::TryParse($inputValue, [ref]$numericValue)) {
            if ($numericValue -ge 1 -and $numericValue -le $Options.Length) {
                return $Options[$numericValue - 1]
            }
        }

        foreach ($option in $Options) {
            if ($option -ieq $inputValue) {
                return $option
            }
        }

        Write-Notice 'Invalid selection. Try again.'
    }
}

function Read-MenuText {
    param(
        [string]$Prompt,
        [string]$DefaultValue
    )

    if ($DefaultValue) {
        $value = Read-Host ("{0} (default: {1})" -f $Prompt, $DefaultValue)
    } else {
        $value = Read-Host $Prompt
    }

    if (-not $value) {
        return $DefaultValue
    }

    return $value.Trim()
}

function Enter-MenuMode {
    param(
        [string]$DefaultMode,
        [string]$DefaultVersion,
        [string]$DefaultInstallDir,
        [string]$DetectedArch,
        [string]$ResolvedVariant,
        [bool]$IsAdmin,
        [string]$WindowsLabel
    )

    Write-Host ''
    Write-Host 'NPS Windows Installer Menu' -ForegroundColor Cyan
    Write-Host ("Windows version : {0}" -f $WindowsLabel)
    Write-Host ("Administrator   : {0}" -f $(if ($IsAdmin) { 'yes' } else { 'no' }))
    Write-Host ("Detected arch   : {0}" -f $DetectedArch)
    Write-Host ("Default variant : {0}" -f $ResolvedVariant)
    Write-Host ("Default dir     : {0}" -f $DefaultInstallDir)
    Write-Host ''

    $archOptions = @('auto', $DetectedArch, 'amd64', '386', 'arm64') | Select-Object -Unique
    $variantOptions = @('auto', $ResolvedVariant, 'modern', 'old') | Select-Object -Unique

    $selectedMode = Read-MenuChoice -Prompt 'Select what to install:' -Options @('all', 'nps', 'npc') -DefaultValue $DefaultMode
    $selectedVersion = Read-MenuText -Prompt 'Release version' -DefaultValue $DefaultVersion
    $selectedArch = Read-MenuChoice -Prompt 'Select architecture:' -Options $archOptions -DefaultValue 'auto'
    $selectedVariant = Read-MenuChoice -Prompt 'Select Windows package variant:' -Options $variantOptions -DefaultValue 'auto'
    $selectedInstallDir = Read-MenuText -Prompt 'Install directory' -DefaultValue $DefaultInstallDir

    return @{
        Mode           = $selectedMode
        Version        = $selectedVersion
        Arch           = $selectedArch
        PackageVariant = $selectedVariant
        InstallDir     = $selectedInstallDir
    }
}

function Assert-WindowsHost {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'install.ps1 only supports Windows hosts.'
    }
}

function Show-NextSteps {
    param(
        [string]$InstalledMode,
        [string]$TargetDir,
        [bool]$IsAdmin
    )

    $quotedDir = '"' + $TargetDir + '"'
    Write-Host ''
    Write-Step 'Installation completed.'
    Write-Host ("Install directory: {0}" -f $TargetDir)
    if (-not $IsAdmin) {
        Write-Notice 'This run did not use administrator privileges. The default install directory was switched to a user-writable path.'
    }
    Write-Host ''
    Write-Host 'Next steps:'

    switch ($InstalledMode) {
        'nps' {
            Write-Host ('  1. Review config: {0}' -f (Join-Path $TargetDir 'conf\nps.conf'))
            Write-Host ('  2. Test run:      Set-Location {0} ; .\nps.exe' -f $quotedDir)
            Write-Host ('  3. Service mode:  open Administrator PowerShell, then run .\nps.exe install')
            if (-not $IsAdmin -or $TargetDir -ne 'C:\Program Files\nps') {
                Write-Host ('                  or .\nps.exe install -conf_path="{0}"' -f $TargetDir)
            }
        }
        'npc' {
            Write-Host ('  1. Edit config:   {0}' -f (Join-Path $TargetDir 'conf\npc.conf'))
            Write-Host ('  2. Test run:      Set-Location {0} ; .\npc.exe -config="{1}"' -f $quotedDir, (Join-Path $TargetDir 'conf\npc.conf'))
            Write-Host ('  3. Service mode:  open Administrator PowerShell, then run .\npc.exe install -config="{0}" -log=off' -f (Join-Path $TargetDir 'conf\npc.conf'))
        }
        default {
            Write-Host ('  1. Review server config: {0}' -f (Join-Path $TargetDir 'conf\nps.conf'))
            Write-Host ('  2. Review client config: {0}' -f (Join-Path $TargetDir 'conf\npc.conf'))
            Write-Host ('  3. Test NPS:            Set-Location {0} ; .\nps.exe' -f $quotedDir)
            Write-Host ('  4. Test NPC:            Set-Location {0} ; .\npc.exe -config="{1}"' -f $quotedDir, (Join-Path $TargetDir 'conf\npc.conf'))
            Write-Host ('  5. Service mode:        open Administrator PowerShell and run .\nps.exe install')
            if (-not $IsAdmin -or $TargetDir -ne 'C:\Program Files\nps') {
                Write-Host ('                         or .\nps.exe install -conf_path="{0}"' -f $TargetDir)
            }
            Write-Host ('                         then configure NPC and run .\npc.exe install -config="{0}" -log=off' -f (Join-Path $TargetDir 'conf\npc.conf'))
        }
    }

    Write-Host ''
    Write-Host 'If GitHub is slow or blocked in your region, the script already tried jsDelivr mirror fallbacks automatically.'
}

Assert-WindowsHost

$isAdmin = Test-IsAdministrator
$windowsInfo = Get-WindowsVersionInfo
$detectedArch = Get-DetectedArchitecture
$defaultInstallDir = Get-DefaultInstallDir -IsAdmin $isAdmin
$resolvedVariantPreview = Resolve-PackageVariant -RequestedVariant $PackageVariant -WindowsVersion $windowsInfo.Version

if ($Menu) {
    $menuResult = Enter-MenuMode `
        -DefaultMode $Mode `
        -DefaultVersion $Version `
        -DefaultInstallDir $(if ($InstallDir) { $InstallDir } else { $defaultInstallDir }) `
        -DetectedArch $detectedArch `
        -ResolvedVariant $resolvedVariantPreview `
        -IsAdmin $isAdmin `
        -WindowsLabel $windowsInfo.Label

    $Mode = $menuResult.Mode
    $Version = $menuResult.Version
    $Arch = $menuResult.Arch
    $PackageVariant = $menuResult.PackageVariant
    $InstallDir = $menuResult.InstallDir
}

if (-not $InstallDir) {
    $InstallDir = $defaultInstallDir
}

$InstallDir = [IO.Path]::GetFullPath($InstallDir)

$resolvedArch = if ($Arch -eq 'auto') { $detectedArch } else { $Arch }
$resolvedVariant = Resolve-PackageVariant -RequestedVariant $PackageVariant -WindowsVersion $windowsInfo.Version
$versionInfo = Resolve-VersionInfo -RequestedVersion $Version
$resolvedVersion = [string]$versionInfo.Version
$useCdnLatest = [bool]$versionInfo.UseCdnLatest

Write-Step 'Windows installer summary'
Write-Host ("Mode            : {0}" -f $Mode)
Write-Host ("Version         : {0}" -f $resolvedVersion)
Write-Host ("Arch            : {0}" -f $resolvedArch)
Write-Host ("Package variant : {0}" -f $resolvedVariant)
Write-Host ("Install dir     : {0}" -f $InstallDir)
Write-Host ("Administrator   : {0}" -f $(if ($isAdmin) { 'yes' } else { 'no' }))

if ($resolvedVariant -eq 'old') {
    Write-Notice 'Using the old Windows release package. This is intended for Windows 7 and Windows 8 / 8.1.'
}

if ((-not $isAdmin) -and $InstallDir.StartsWith('C:\Program Files', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Administrator privileges are required when the install directory is under C:\Program Files. Re-run the script as administrator or choose another install directory.'
}

$components = switch ($Mode) {
    'nps' { @('nps') }
    'npc' { @('npc') }
    default { @('nps', 'npc') }
}

$tempRoot = Join-Path $env:TEMP ('nps-install-' + [Guid]::NewGuid().ToString('N'))
Ensure-Directory -Path $tempRoot

try {
    foreach ($component in $components) {
        $assetName = Get-AssetName -Component $component -ResolvedArch $resolvedArch -ResolvedVariant $resolvedVariant
        $archivePath = Join-Path $tempRoot $assetName
        $extractPath = Join-Path $tempRoot ([IO.Path]::GetFileNameWithoutExtension([IO.Path]::GetFileNameWithoutExtension($assetName)))
        $urls = Get-DownloadUrls -AssetName $assetName -ResolvedVersion $resolvedVersion -UseCdnLatest $useCdnLatest

        Write-Step ("Downloading {0} package" -f $component)
        $downloadedFrom = Invoke-DownloadWithFallback -Urls $urls -DestinationPath $archivePath
        Write-Info ("Downloaded from {0}" -f $downloadedFrom)

        Write-Step ("Extracting {0} package" -f $component)
        Expand-TarGzArchive -ArchivePath $archivePath -DestinationPath $extractPath

        Write-Step ("Installing {0} into {1}" -f $component, $InstallDir)
        switch ($component) {
            'nps' { Install-NpsPackage -SourceRoot $extractPath -TargetRoot $InstallDir }
            'npc' { Install-NpcPackage -SourceRoot $extractPath -TargetRoot $InstallDir }
        }
    }
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Show-NextSteps -InstalledMode $Mode -TargetDir $InstallDir -IsAdmin $isAdmin
