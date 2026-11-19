# Build-time only. The installed application runs the private copies in local-mcp-runtime.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'runtime/local-mcp'
$stage = Join-Path $root 'apps/desktop/dist-local-mcp'
$cache = Join-Path $root 'output/local-mcp-runtime-cache'
$archive = Join-Path $cache 'node-v24.18.1-win-x64.zip'
New-Item -ItemType Directory -Force $stage,$cache | Out-Null
$expected = 'ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765'
if (!(Test-Path $archive) -or (Get-FileHash $archive).Hash -ne $expected) {
    Invoke-WebRequest 'https://nodejs.org/dist/v24.18.1/node-v24.18.1-win-x64.zip' -OutFile $archive -UseBasicParsing
}
if ((Get-FileHash $archive).Hash -ne $expected) { throw 'Node.js archive checksum mismatch' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    foreach ($name in @('node.exe','LICENSE')) {
        $target = if ($name -eq 'LICENSE') { 'NODE-LICENSE.txt' } else { $name }
        $entry = $zip.GetEntry("node-v24.18.1-win-x64/$name")
        $file = Join-Path $stage $target
        $stream = $entry.Open()
        try { $entryHash = (Get-FileHash -InputStream $stream).Hash } finally { $stream.Dispose() }
        if (!(Test-Path $file) -or (Get-FileHash $file).Hash -ne $entryHash) {
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$file,$true)
        }
    }
} finally { $zip.Dispose() }
$dependencyHash = (Get-FileHash "$source/package-lock.json").Hash
$stamp = Join-Path $stage '.dependencies'
$ready = (Test-Path -LiteralPath $stamp) -and ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $dependencyHash) -and (Test-Path "$stage/node_modules/@modelcontextprotocol/sdk/package.json")
Copy-Item "$source/package.json","$source/package-lock.json" $stage -Force
if ($ready) { return }
& npm.cmd ci --prefix $stage --omit=dev --ignore-scripts --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { throw 'Could not stage locked local MCP dependencies' }
Set-Content -LiteralPath $stamp -Value $dependencyHash
