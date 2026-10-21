# app-footprint.ps1 - OBSERVE-ONLY whole-app footprint sampler (2026-10-20, piece 3 of the "eats my PC" plan).
# StarNet's idle cost has four payers: the Tauri host, the WebView2 tree (browser / GPU / renderer / utilities) and
# the node sidecar. This reads all of them from the OS, attributed by walking ParentProcessId from the app's OWN pid.
# It never focuses, resizes, clicks or kills anything, and it never selects a process by name below the root:
# on the reference box 13 msedgewebview2.exe belonged to SearchHost and GoogleDriveFS, none to StarNet.
#
#   Andrew's installed app (observe only):
#     powershell -NoProfile -File scripts/perf/app-footprint.ps1 -RootName skynet-desktop -Seconds 120
#   A bench's own processes (the renderer A/B bench passes its Edge root + its sidecar):
#     powershell -NoProfile -File scripts/perf/app-footprint.ps1 -RootPid 1234,5678 -Seconds 60 -NoIdentity -Compress
#   [-Interval 2] [-Windows 1] [-StartAtMs <epoch ms>] [-UserDataFolder <WEBVIEW2_USER_DATA_FOLDER of the app>] [-Out f.json]
#
# Rules (mirrored in scripts/lib/proc-footprint.mjs; test/proc-footprint.test.js locks the shared constants):
#   CPU    = 100 x delta(TotalProcessorTime) / wall, percent of ONE core.
#   RAM    = PrivateMemorySize64. Working set is reported but is pressure-dependent: under memory pressure the
#            GPU process showed 9.5 MB working set against 71.9 MB private (dry run 2026-10-20).
#   GPU %  = Task Manager's rule: sum '\GPU Engine(pid_<p>_*)\Utilization Percentage' per (adapter luid, engine
#            type), then the busiest. Two adapters on the reference box (AMD 144 Hz, NVIDIA 239 Hz).
#   GPU MB = '\GPU Process Memory(pid_<p>_*)\Dedicated Usage' and '\Shared Usage', summed over adapters.
#   One Get-Counter call per window (-SampleInterval -MaxSamples) over a fixed pid set; the tree is re-walked per window.
#   CONTENDED when system CPU outside the measured tree is over $ContendedCpuPct % of all cores, or free RAM is under
#            $ContendedFreeGB GB (the sidecar idle bench's rule). A contended window is reported, never a verdict.
#   Identity: a WebView2 browser child (msedgewebview2.exe with no --type) must have a --user-data-dir ending in
#            <Identifier>\EBWebView, or be -UserDataFolder (+ EBWebView). -NoIdentity skips it (the bench's own Edge).
param(
  [string]$RootPid = '',
  [string]$RootName = '',
  [int]$Seconds = 120,
  [int]$Interval = 2,
  [int]$Windows = 1,
  [string]$Identifier = 'ai.skynet.harness',
  [string]$UserDataFolder = '',
  [double]$StartAtMs = 0,
  [string]$Out = '',
  [switch]$NoIdentity,
  [switch]$Compress
)
$ErrorActionPreference = 'Stop'
$ContendedCpuPct = 20
$ContendedFreeGB = 4
$cores = [Environment]::ProcessorCount

function Norm([string]$p) { return ($p -replace '/', '\' -replace '^"+|"+$', '' -replace '\\+$', '').ToLowerInvariant() }
function ToMs($dt) { if ($null -eq $dt) { return $null }; return [double]([DateTimeOffset]$dt.ToUniversalTime()).ToUnixTimeMilliseconds() }

function Get-Tree {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, CreationDate)
  $roots = @()
  if ($RootPid) {
    $want = @($RootPid -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { [int]$_ })
    $roots = @($all | Where-Object { $want -contains [int]$_.ProcessId })
  } elseif ($RootName) {
    $exe = if ($RootName -imatch '\.exe$') { $RootName } else { $RootName + '.exe' }
    $roots = @($all | Where-Object { $_.Name -ieq $exe })   # the ROOT may be named; nothing below it ever is
  }
  $byParent = @{}
  foreach ($p in $all) { $k = [string][int]$p.ParentProcessId; if (-not $byParent.ContainsKey($k)) { $byParent[$k] = New-Object System.Collections.ArrayList }; [void]$byParent[$k].Add($p) }
  $rootIds = @{}; foreach ($r in $roots) { $rootIds[[string][int]$r.ProcessId] = $true }
  $seen = [ordered]@{}; $q = New-Object System.Collections.Queue
  foreach ($r in $roots) { $q.Enqueue($r) }
  while ($q.Count) {
    $p = $q.Dequeue(); $id = [string][int]$p.ProcessId
    if ($seen.Contains($id)) { continue }
    $seen[$id] = $p
    $born = ToMs $p.CreationDate
    if ($byParent.ContainsKey($id)) {
      foreach ($c in $byParent[$id]) {
        if ([int]$c.ProcessId -eq [int]$p.ProcessId) { continue }
        $cb = ToMs $c.CreationDate
        if ($null -ne $born -and $null -ne $cb -and $cb -lt $born) { continue }   # pid reuse: born before its "parent"
        $q.Enqueue($c)
      }
    }
  }
  return @{ rows = @($seen.Values); rootIds = $rootIds }
}

function Role($p, [bool]$isRoot) {
  $c = [string]$p.CommandLine; $n = [string]$p.Name
  if ($n -imatch '^(msedgewebview2|msedge|chrome|chromium|chrome-headless-shell)\.exe$') {
    if ($c -notmatch '--type=([\w-]+)') { return 'web-browser' }
    $t = $Matches[1]
    if ($t -eq 'gpu-process') { return 'web-gpu' }
    if ($t -eq 'renderer') { return 'web-renderer' }
    if ($t -eq 'crashpad-handler') { return 'web-crashpad' }
    if ($t -eq 'utility') {
      if ($c -match '--utility-sub-type=([\w\.]+)') { return 'web-util:' + ($Matches[1] -replace '\.mojom\..*$', '').ToLowerInvariant() }
      return 'web-util:unknown'
    }
    return 'web-other:' + $t
  }
  if ($n -imatch '^node(\.exe)?$') { if ($c -imatch 'sidecar[\\/]+index\.js') { return 'sidecar' } else { return 'node-child' } }
  if ($n -imatch '^(conhost|cmd|powershell|pwsh|bash|sh)\.exe$') { return 'shell' }
  if ($isRoot) { return 'host' }
  return 'other:' + ($n -replace '\.exe$', '').ToLowerInvariant()
}

# only the flags the role rule reads leave this script: a node child's command line can carry a token
function Sig($p) {
  $c = [string]$p.CommandLine; $s = @()
  if ($c -match '--type=[\w-]+') { $s += $Matches[0] }
  if ($c -match '--utility-sub-type=[\w\.]+') { $s += $Matches[0] }
  if ($c -imatch 'sidecar[\\/]+index\.js') { $s += 'sidecar\index.js' }
  return ($s -join ' ')
}

function UserDataDir($p) {
  $c = [string]$p.CommandLine
  if ($c -match '--user-data-dir="([^"]+)"') { return $Matches[1] }
  if ($c -match '--user-data-dir=(\S+)') { return $Matches[1] }
  return $null
}

function Identity($rows) {
  $out = @()
  if ($NoIdentity -or (-not $Identifier -and -not $UserDataFolder)) { return [ordered]@{ checked = $false; ok = $null; browsers = @() } }
  foreach ($p in $rows) {
    if ([string]$p.Name -ine 'msedgewebview2.exe' -or [string]$p.CommandLine -match '--type=') { continue }
    $d = UserDataDir $p; $ok = $false
    if ($d) {
      $nd = Norm $d
      if ($Identifier -and $nd.EndsWith('\' + (Norm $Identifier) + '\ebwebview')) { $ok = $true }
      if ($UserDataFolder) { $u = Norm $UserDataFolder; if ($nd -eq $u -or $nd -eq ($u + '\ebwebview')) { $ok = $true } }
    }
    $out += [ordered]@{ pid = [int]$p.ProcessId; userDataDir = $d; ok = $ok }
  }
  $allOk = $true; foreach ($b in $out) { if (-not $b.ok) { $allOk = $false } }
  return [ordered]@{ checked = $true; ok = ($out.Count -gt 0 -and $allOk); browsers = $out; note = $(if ($out.Count -eq 0) { 'no WebView2 browser child under the root' } else { $null }) }
}

function Snap($ids) {
  $o = @{}
  foreach ($id in $ids) {
    try {
      $gp = Get-Process -Id ([int]$id) -ErrorAction Stop
      $o[[string]$id] = @{ cpu = $gp.TotalProcessorTime.TotalMilliseconds; ws = $gp.WorkingSet64; priv = $gp.PrivateMemorySize64; start = $(try { ToMs $gp.StartTime } catch { $null }) }
    } catch {}
  }
  return $o
}

function Window([int]$w) {
  $t = Get-Tree
  $rows = @($t.rows)
  if (-not $rows.Count) { return $null }
  $ids = @($rows | ForEach-Object { [string][int]$_.ProcessId })
  $paths = @('\Processor(_Total)\% Processor Time', '\Memory\Available MBytes')
  foreach ($id in $ids) {
    $paths += "\GPU Engine(pid_$($id)_*)\Utilization Percentage"
    $paths += "\GPU Process Memory(pid_$($id)_*)\Dedicated Usage"
    $paths += "\GPU Process Memory(pid_$($id)_*)\Shared Usage"
  }
  # the CPU window is exactly -Seconds from the mark: the counter samples get (Seconds - 1 s) so Get-Counter's own setup
  # fits inside, then the rest is slept out (a 3 s window once read 2.4 s of CPU against a caller's 3.0 s, 2026-10-20)
  $n = [math]::Max(1, [int][math]::Floor(($Seconds - 1) / [math]::Max(1, $Interval)))
  if ($w -eq 1 -and $StartAtMs -gt 0) {   # the tree is walked BEFORE the wait: the window opens on the caller's mark
    $wait = $StartAtMs - [double][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) }
  }
  $s0 = Snap $ids; $sw = [Diagnostics.Stopwatch]::StartNew(); $t0ms = [double][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $sets = @(); $counterError = $null
  try { $sets = @(Get-Counter -Counter $paths -SampleInterval $Interval -MaxSamples $n -ErrorAction SilentlyContinue) }
  catch { $counterError = $_.Exception.Message }
  $rest = $Seconds * 1000 - $sw.Elapsed.TotalMilliseconds
  if ($rest -gt 0) { Start-Sleep -Milliseconds ([int]$rest) }
  $wall = $sw.Elapsed.TotalMilliseconds
  $s1 = Snap $ids  # close the window first; the re-walk below takes a CIM query's time
  $t2 = Get-Tree   # catch children born mid-window (a renderer for a new target, a GPU process restart)
  $born = @{}; foreach ($p in $t2.rows) { $k = [string][int]$p.ProcessId; if ($ids -notcontains $k) { $born[$k] = $p } }
  $allRows = @($rows) + @($born.Values)
  $sb = Snap @($born.Keys); foreach ($k in $sb.Keys) { $s1[$k] = $sb[$k] }

  # counters: per pid per sample the Task Manager GPU rule; system CPU and free RAM per sample
  $gpu = @{}; $mem = @{}; $sys = @(); $freeMB = @()
  foreach ($set in $sets) {
    $per = @{}
    foreach ($s in $set.CounterSamples) {
      $path = [string]$s.Path; $inst = [string]$s.InstanceName
      if ($path -match '\\processor\(_total\)\\') { $sys += [double]$s.CookedValue; continue }
      if ($path -match '\\memory\\available mbytes') { $freeMB += [double]$s.CookedValue; continue }
      if ($inst -notmatch '^pid_(\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+(?:_eng_\d+_engtype_(.*))?$') { continue }
      $id = [string][int]$Matches[1]; $luid = $Matches[2]; $et = $Matches[3]
      if ($path -match 'gpu engine') {
        if (-not $per.ContainsKey($id)) { $per[$id] = @{} }
        $k = $luid + '|' + ([string]$et).ToLowerInvariant()
        $per[$id][$k] = [double]($per[$id][$k]) + [double]$s.CookedValue
      } elseif ($path -match 'gpu process memory') {
        if (-not $mem.ContainsKey($id)) { $mem[$id] = @{ ded = @{}; sh = @{} } }
        $slot = if ($path -match 'dedicated usage') { 'ded' } else { 'sh' }
        $mem[$id][$slot][$luid] = [double]$s.CookedValue   # last sample wins (bytes)
      }
    }
    foreach ($id in $per.Keys) {
      $best = 0.0; $bestK = $null
      foreach ($k in $per[$id].Keys) { if ($per[$id][$k] -gt $best) { $best = $per[$id][$k]; $bestK = $k } }
      if (-not $gpu.ContainsKey($id)) { $gpu[$id] = @{ sum = 0.0; max = 0.0; n = 0; types = @{} } }
      $gpu[$id].sum += $best; $gpu[$id].n++; if ($best -gt $gpu[$id].max) { $gpu[$id].max = $best }
      foreach ($k in $per[$id].Keys) { $gpu[$id].types[$k] = [double]($gpu[$id].types[$k]) + $per[$id][$k] }
    }
  }
  $nsets = [math]::Max(1, $sets.Count)

  $procs = New-Object System.Collections.ArrayList; $exited = @()
  $treeCpu = 0.0
  foreach ($p in $allRows) {
    $id = [string][int]$p.ProcessId
    if (-not $s1.ContainsKey($id)) { $exited += [int]$id; continue }
    $c0 = if ($s0.ContainsKey($id)) { $s0[$id].cpu } elseif ($born.ContainsKey($id)) { 0 } else { $null }
    if ($null -eq $c0) { continue }
    $cpu = [math]::Round(100 * ($s1[$id].cpu - $c0) / $wall, 2); $treeCpu += $cpu
    $g = $gpu[$id]; $m = $mem[$id]
    $ded = 0.0; $sh = 0.0
    if ($m) { foreach ($v in $m.ded.Values) { $ded += $v }; foreach ($v in $m.sh.Values) { $sh += $v } }
    $types = [ordered]@{}; if ($g) { foreach ($k in $g.types.Keys) { $types[$k] = [math]::Round($g.types[$k] / $nsets, 2) } }
    $isRoot = [bool]$t.rootIds.ContainsKey($id)
    $row = [ordered]@{
      pid = [int]$id; ppid = [int]$p.ParentProcessId; name = [string]$p.Name; role = (Role $p $isRoot); sig = (Sig $p)
      created = $(if ($p.CreationDate) { ([DateTime]$p.CreationDate).ToUniversalTime().ToString('o') } else { $null }); bornInWindow = $born.ContainsKey($id)
      cpuMs = [math]::Round($s1[$id].cpu - $c0, 1); cpuPctOneCore = $cpu
      privMB = [math]::Round($s1[$id].priv / 1MB, 1); wsMB = [math]::Round($s1[$id].ws / 1MB, 1)
      gpuPct = $(if ($g) { [math]::Round($g.sum / $nsets, 2) } else { 0 }); gpuPctMax = $(if ($g) { [math]::Round($g.max, 2) } else { 0 }); gpuByType = $types
      gpuDedMB = [math]::Round($ded / 1MB, 1); gpuSharedMB = [math]::Round($sh / 1MB, 1)
    }
    if ($row.role -eq 'web-browser') { $row.userDataDir = (UserDataDir $p) }
    [void]$procs.Add($row)
  }

  $byRole = [ordered]@{}; $tot = [ordered]@{ n = 0; cpuPctOneCore = 0.0; privMB = 0.0; wsMB = 0.0; gpuPct = 0.0; gpuDedMB = 0.0 }
  foreach ($r in $procs) {
    if (-not $byRole.Contains($r.role)) { $byRole[$r.role] = [ordered]@{ n = 0; cpuPctOneCore = 0.0; privMB = 0.0; wsMB = 0.0; gpuPct = 0.0; gpuDedMB = 0.0 } }
    foreach ($o in @($byRole[$r.role], $tot)) {
      $o.n++; $o.cpuPctOneCore = [math]::Round($o.cpuPctOneCore + $r.cpuPctOneCore, 2); $o.privMB = [math]::Round($o.privMB + $r.privMB, 1)
      $o.wsMB = [math]::Round($o.wsMB + $r.wsMB, 1); $o.gpuPct = [math]::Round($o.gpuPct + $r.gpuPct, 2); $o.gpuDedMB = [math]::Round($o.gpuDedMB + $r.gpuDedMB, 1)
    }
  }
  $sysAvg = $null; if ($sys.Count) { $a = 0.0; foreach ($v in $sys) { $a += $v }; $sysAvg = [math]::Round($a / $sys.Count, 1) }
  $freeGB = $null; if ($freeMB.Count) { $lo = $freeMB[0]; foreach ($v in $freeMB) { if ($v -lt $lo) { $lo = $v } }; $freeGB = [math]::Round($lo / 1024, 2) }
  $outside = $null; if ($null -ne $sysAvg) { $outside = [math]::Round($sysAvg - $treeCpu / $cores, 1) }
  $reasons = @()
  if ($null -ne $outside -and $outside -gt $ContendedCpuPct) { $reasons += "system CPU outside the measured tree $outside% > $ContendedCpuPct%" }
  if ($null -ne $freeGB -and $freeGB -lt $ContendedFreeGB) { $reasons += "free RAM $freeGB GB < $ContendedFreeGB GB" }
  return [ordered]@{
    window = $w; startedAtMs = $t0ms; wallS = [math]::Round($wall / 1000, 2); counterSamples = $sets.Count; counterError = $counterError
    preflight = [ordered]@{ systemCpuPctAvg = $sysAvg; treeCpuPctOneCore = [math]::Round($treeCpu, 2); outsideCpuPct = $outside; freeGB = $freeGB; cores = $cores; contended = ($reasons.Count -gt 0); reasons = $reasons }
    identity = (Identity $allRows)
    total = $tot; byRole = $byRole; processes = $procs; exited = $exited
  }
}

$root = $(if ($RootPid) { $RootPid } else { $RootName })
$wins = @()
for ($w = 1; $w -le [math]::Max(1, $Windows); $w++) { $r = Window $w; if ($null -eq $r) { break }; $wins += $r }
if (-not $wins.Count) {
  $res = [ordered]@{ tool = 'app-footprint'; running = $false; root = $root; at = (Get-Date).ToUniversalTime().ToString('o') }
} else {
  $res = [ordered]@{ tool = 'app-footprint'; running = $true; root = $root; at = (Get-Date).ToUniversalTime().ToString('o'); cores = $cores; intervalS = $Interval
    contended = (@($wins | Where-Object { $_.preflight.contended }).Count -gt 0); windows = $wins }
}
$json = $(if ($Compress) { $res | ConvertTo-Json -Depth 8 -Compress } else { $res | ConvertTo-Json -Depth 8 })
if ($Out) { [IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false)) }
Write-Output $json
