# Weekly improvement of the browser-cdp skill (OPTIONAL self-improvement loop).
#
# Launched by a Windows scheduled task you create yourself (see docs/self-improvement.md). If the
# computer is off at the scheduled time, Windows runs it as soon as it can ("StartWhenAvailable").
# There is no analysis logic here: this only orchestrates.
#
#   1. Warns if the previous run died halfway (its lock is still there).
#   2. Looks for sessions in pending-sessions/. If there are none, it ends.
#   3. Takes a snapshot of the ones there are NOW (those arriving while it runs are analysed next
#      week) and splits them into batches of 15, oldest first.
#   4. For each batch it launches claude -p with the browser-cdp-optimizer agent, without permission
#      prompts, watched: if it spends 30 min without writing anything to its transcript, it is cut.
#   5. Only if the batch ended well AND left a new entry in improvement-log/ does it delete that
#      batch's sessions. If something fails, nothing of that batch is deleted and the next batches
#      are not launched: whatever is left is retried next week.
#   6. Leaves a trace in the log and notifies the user with a Windows notification.
#
# The script lives outside the skill's folder on purpose: the agent has free rein inside the skill
# and must not be able to touch the mechanism that launches it.
#
# Every parameter has a sensible default; the scheduled task passes none.

param(
    [string]$SkillDir    = (Join-Path $env:USERPROFILE '.claude\skills\browser-cdp'),
    [string]$ClaudeExe   = '',
    [string]$ProjectsDir = (Join-Path $env:USERPROFILE '.claude\projects'),
    [string]$LogFile     = (Join-Path $env:USERPROFILE '.claude\bin\browser-cdp-improvement.log'),
    [string]$LockDir     = (Join-Path $env:TEMP 'browser-cdp-improvement.lock'),
    [string]$Model       = 'opus',
    [string]$Effort      = 'max',
    [int]$BatchSize      = 15,
    [int]$IdleMinutes    = 30,
    [double]$MaxHours    = 4.5,
    [switch]$NoToast
)

$ErrorActionPreference = 'Continue'
$OutputEncoding = [System.Text.Encoding]::UTF8
# claude emits UTF-8; without this, Windows PowerShell 5.1 decodes its output with the OEM code page
# and non-ASCII characters reach the log mangled.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if (-not $ClaudeExe) {
    $found = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
    $ClaudeExe = if ($found) { $found.Source } else { Join-Path $env:USERPROFILE '.local\bin\claude.exe' }
}

$PendDir = Join-Path $SkillDir 'pending-sessions'
$RawDir  = Join-Path $PendDir 'raw'
$LogDir  = Join-Path $SkillDir 'improvement-log'

# Write-Host and not Write-Output: this is called from functions that return values, and through
# the pipeline it would leak into what they return.
function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
}

# Windows only shows a toast if its AppId is an AUMID registered in the system (the ones
# Get-StartApps lists); an arbitrary name is silently discarded. It uses the Claude desktop app's if
# installed and, otherwise, Windows PowerShell's, present on every Windows.
$script:ToastAppId = $null
function Get-ToastAppId {
    if (-not $script:ToastAppId) {
        $script:ToastAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
        try {
            $app = Get-StartApps -ErrorAction Stop | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1
            if ($app) { $script:ToastAppId = $app.AppID }
        } catch { }
    }
    return $script:ToastAppId
}

function Show-Toast {
    param([string]$Message)
    if ($NoToast) { return }
    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
        $safe = $Message -replace '&', 'and' -replace '<', '' -replace '>', ''
        $xmlText = '<toast><visual><binding template="ToastText02">' +
                   '<text id="1">browser-cdp skill</text>' +
                   '<text id="2">' + $safe + '</text>' +
                   '</binding></visual></toast>'
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($xmlText)
        $toast = New-Object Windows.UI.Notifications.ToastNotification($xml)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier((Get-ToastAppId)).Show($toast)
    } catch { }
}

# --- Transcript of a batch's agent (its activity is what the watchdog watches) ---
function Find-Transcript([string]$Sid) {
    $expected = Join-Path (Join-Path $ProjectsDir ($SkillDir -replace '[^A-Za-z0-9]', '-')) "$Sid.jsonl"
    if (Test-Path $expected) { return $expected }
    $f = Get-ChildItem $ProjectsDir -Filter "$Sid.jsonl" -Recurse -Depth 1 -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($f) { return $f.FullName }
    return $null
}

function Get-LastActivity([string]$Transcript) {
    $dates = @()
    if ($Transcript -and (Test-Path $Transcript)) {
        $dates += (Get-Item $Transcript).LastWriteTime
        $sub = Join-Path ([IO.Path]::ChangeExtension($Transcript, $null)) 'subagents'
        if (Test-Path $sub) { $dates += @(Get-ChildItem $sub -File | ForEach-Object { $_.LastWriteTime }) }
    }
    if ($dates.Count -eq 0) { return [datetime]::MinValue }
    return ($dates | Sort-Object | Select-Object -Last 1)
}

# --- One batch: launches the specialist, watched, and returns how it ended ---
function Invoke-Batch([string[]]$Batch, [string]$Label) {
    $sid = [guid]::NewGuid().ToString()
    $stdout = Join-Path $env:TEMP "browser-cdp-improvement-$sid.out"
    $stderr = Join-Path $env:TEMP "browser-cdp-improvement-$sid.err"
    # No double quotes inside: it goes on the command line.
    $prompt = "Batch $Label. Analyse ONLY these $($Batch.Count) sessions in pending-sessions/: $($Batch -join ', '). " +
              "The folder may hold more: they belong to other batches, neither read nor count them. " +
              "Find where the skill failed or cost more than it should, apply the improvements you can justify " +
              "and finish by creating your new entry in improvement-log/."
    $arguments = ('-p "{0}" --agent browser-cdp-optimizer --model {1} --effort {2} ' +
                  '--permission-mode bypassPermissions --output-format json --session-id {3}') -f $prompt, $Model, $Effort, $sid

    # The optimizer's session runs cdp.js ("node .../cdp.js help") and the SessionEnd hook would
    # capture it as real use of the skill, feeding pending-sessions/ with its own analyses. This
    # variable, which the hook checks, tells it not to capture this session.
    $env:BROWSER_CDP_NO_CAPTURE = '1'
    $start = Get-Date
    try {
        $proc = Start-Process -FilePath $ClaudeExe -ArgumentList $arguments -WorkingDirectory $SkillDir `
            -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $null = $proc.Handle   # without this, ExitCode comes back empty at the end
    } finally {
        Remove-Item Env:BROWSER_CDP_NO_CAPTURE -ErrorAction SilentlyContinue
    }

    # Watchdog: a run can hang on a tool call and sit there for hours with nobody noticing. If the
    # transcript (or its subagents') goes this long without being written, the whole process tree
    # is killed.
    $activity = $start
    $transcript = $null
    $killed = $false
    while (-not $proc.WaitForExit(30000)) {
        if (-not $transcript) { $transcript = Find-Transcript $sid }
        $last = Get-LastActivity $transcript
        if ($last -gt $activity) { $activity = $last }
        if (((Get-Date) - $activity).TotalMinutes -ge $IdleMinutes) {
            & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
            $null = $proc.WaitForExit(60000)
            $killed = $true
            break
        }
    }
    $code = if ($killed) { -1 } else { $proc.ExitCode }

    $summary = ''
    try {
        $raw = Get-Content $stdout -Raw -Encoding UTF8 -ErrorAction Stop
        if ($raw) {
            try { $summary = [string](($raw | ConvertFrom-Json).result) } catch { $summary = $raw }
        }
    } catch { }
    if (-not $summary) {
        try { $summary = (Get-Content $stderr -Raw -Encoding UTF8 -ErrorAction Stop) } catch { }
    }
    Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue

    return [pscustomobject]@{
        Code = $code; Killed = $killed; Start = $start
        Minutes = [int]((Get-Date) - $start).TotalMinutes; Summary = "$summary".Trim()
    }
}

# --- Integrity of the scripts after each batch ---
# The agent checks its own changes, but if claude dies halfway through an edit or the agent did not
# revert what it broke, a script would stay unusable until the next real use and nobody would know.
# `help` makes node parse the whole cdp.js without touching the browser; the .ps1 files are parsed
# without running (ensure-chrome.ps1 would launch Chrome; virtual-desktop.ps1 may run on every
# message through a hook, and broken it would fail silently). A missing file makes ParseFile return
# a ParseError, which also deserves the alert. No automatic revert on purpose: a node broken at
# system level would cause unjustified reverts.
function Test-Integrity {
    $failures = @()
    $cdpJs = Join-Path $SkillDir 'scripts\cdp.js'
    if (Get-Command node -ErrorAction SilentlyContinue) {
        & node $cdpJs help >$null 2>$null
        if ($LASTEXITCODE -ne 0) { $failures += "cdp.js (exit code $LASTEXITCODE)" }
    } else {
        Write-Log "node is not in PATH: could not check the integrity of cdp.js."
    }
    foreach ($ps in 'ensure-chrome.ps1', 'virtual-desktop.ps1') {
        $toks = $null; $errs = $null
        $null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $SkillDir "scripts\$ps"), [ref]$toks, [ref]$errs)
        if ($errs.Count -gt 0) {
            $failures += "$ps ($($errs.Count) parse errors; the first, line $($errs[0].Extent.StartLineNumber): $($errs[0].Message))"
        }
    }
    return ,$failures
}

# --- Files of a pending session: index, raw transcript and subagents' raw transcripts ---
function Get-SessionFiles([string]$Base) {
    $f = @((Join-Path $PendDir "$Base.md"), (Join-Path $RawDir "$Base.jsonl"))
    $sub = Join-Path $RawDir "$Base.subagents"
    if (Test-Path $sub) { $f += @(Get-ChildItem $sub -File | ForEach-Object { $_.FullName }) }
    return ,$f
}

# --- Bounded log: above 1 MB only the last half is kept ---
try {
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 1MB)) {
        $lines = Get-Content $LogFile
        $lines | Select-Object -Last ([int]($lines.Count / 2)) | Set-Content $LogFile -Encoding utf8
    }
} catch { }

Write-Log "=== Start ==="

# --- Lock: two runs at once would step on each other when deleting ---
# A lock older than 6 h (the task's time limit) belongs to a run that died halfway: shutdown, log
# off or time limit. It is reported, because that death leaves no other trace.
if (Test-Path $LockDir) {
    $created = (Get-Item $LockDir).CreationTime
    $age = (Get-Date) - $created
    if ($age.TotalHours -lt 6) {
        Write-Log "A run is already in progress (lock from $([int]$age.TotalMinutes) min ago). Exiting."
        exit 0
    }
    Write-Log ("WARNING: the previous run did not finish (lock from {0:yyyy-MM-dd HH:mm}): it died halfway. " -f $created +
               "Whatever it did not delete is still pending and goes into this one.")
    Show-Toast "The previous weekly run died halfway; its sessions go into this one."
    Remove-Item $LockDir -Recurse -Force -ErrorAction SilentlyContinue
}
try { New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null }
catch { Write-Log "Could not acquire the lock. Exiting."; exit 0 }

try {
    if (-not (Test-Path $ClaudeExe)) {
        Write-Log "ERROR: claude not found at $ClaudeExe"
        Show-Toast "The weekly improvement could not start: claude not found."
        exit 1
    }
    # --- Heartbeat of the capture hook ---
    # The hook touches it on every session end (capturing or not); if it has not been touched for
    # more than 8 days, the hook is dead (e.g. node missing from the PATH) and "no pending sessions"
    # would be a false "all good".
    $heartbeat = Join-Path $PendDir '.last-heartbeat'
    if (Test-Path $heartbeat) {
        $days = ((Get-Date) - (Get-Item $heartbeat).LastWriteTime).TotalDays
        if ($days -gt 8) {
            Write-Log "WARNING: the session capture hook has shown no sign of life for $([int]$days) days. Check the SessionEnd hook in settings.json."
            Show-Toast "The session capture hook has been silent for $([int]$days) days: check the SessionEnd hook in settings.json."
        }
    } else {
        Write-Log "The capture hook's heartbeat file does not exist yet (normal only right after installing)."
    }

    if (-not (Test-Path $PendDir)) {
        Write-Log "The pending-sessions folder does not exist. Nothing to do."
        exit 0
    }

    # --- Snapshot of what to analyse, in batches, oldest first ---
    # (names start with the date, so alphabetical order is chronological)
    $bases = @(Get-ChildItem -Path $PendDir -Filter '*.md' -File -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -ne 'README.md' } |
               ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($_.Name) } | Sort-Object)
    if ($bases.Count -eq 0) {
        Write-Log "No pending sessions. Nothing to analyse."
        exit 0
    }
    $batches = @()
    for ($i = 0; $i -lt $bases.Count; $i += $BatchSize) {
        $batches += , @($bases[$i..([math]::Min($i + $BatchSize, $bases.Count) - 1)])
    }
    $mb = [Math]::Round((Get-ChildItem $PendDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
    Write-Log "$($bases.Count) pending sessions ($mb MB) in $($batches.Count) batch(es) of up to $BatchSize."

    $startAll = Get-Date
    $analysed = 0; $deleted = 0; $kept = 0; $batchesDone = 0
    $problem = $null

    for ($n = 0; $n -lt $batches.Count; $n++) {
        $batch = $batches[$n]
        $label = "$($n + 1)/$($batches.Count)"
        if ($n -gt 0 -and ((Get-Date) - $startAll).TotalHours -ge $MaxHours) {
            Write-Log "Cap of $MaxHours h reached: the remaining $($batches.Count - $n) batch(es) wait for next week."
            break
        }

        Write-Log "Batch ${label}: $($batch -join ', ')"
        Write-Log "Launching browser-cdp-optimizer ($Model, effort $Effort)..."
        $r = Invoke-Batch $batch $label
        if ($r.Killed) {
            Write-Log "The agent of batch $label was cut after $IdleMinutes min without activity ($($r.Minutes) min in total)."
        } else {
            Write-Log "The agent of batch $label ended with code $($r.Code) after $($r.Minutes) min."
        }
        if ($r.Summary) { Write-Log "--- Agent summary ---`n$($r.Summary)`n--- end ---" }

        $failures = Test-Integrity
        foreach ($f in $failures) {
            Write-Log "ALERT: $f fails the integrity check after batch $label. Review it or revert it with git."
        }

        # Evidence: the batch is only good if an improvement-log entry appeared (or was updated)
        # after its agent was launched.
        $status = if ($r.Killed) { 'cut' } elseif ($r.Code -ne 0) { "failed $($r.Code)" } else { 'ok' }
        $entries = @(Get-ChildItem -Path $LogDir -Filter '*.md' -File -ErrorAction SilentlyContinue |
                     Where-Object { $_.Name -ne 'README.md' -and $_.LastWriteTime -gt $r.Start })
        if ($status -eq 'ok' -and $entries.Count -eq 0) { $status = 'no report' }

        if ($status -ne 'ok') {
            $problem = switch ($status) {
                'cut'       { "batch $label hung and was cut" }
                'no report' { "batch $label ended without leaving a report" }
                default     { "batch $label failed (exit code $($r.Code))" }
            }
            Write-Log "Problem: $problem. NOTHING of that batch is deleted and the next batches are not launched."
            break
        }

        # --- Cleanup: only this batch's sessions ---
        # And of those, only the ones not rewritten while the agent was running: if a resumed session
        # that was already captured ends during the analysis, the hook rewrites its files with content
        # the agent never saw, and deleting it would lose that unanalysed delta. The whole session is
        # kept and goes into next week's run.
        foreach ($base in $batch) {
            $files = Get-SessionFiles $base
            $rewritten = @($files | Where-Object { (Test-Path $_) -and ((Get-Item $_).LastWriteTime -gt $r.Start) })
            if ($rewritten.Count -gt 0) {
                Write-Log "Keeping $base whole: rewritten during the analysis."
                $kept++
                continue
            }
            foreach ($path in $files) {
                if (Test-Path $path) {
                    Remove-Item $path -Force -ErrorAction SilentlyContinue
                    if (-not (Test-Path $path)) { $deleted++ }
                }
            }
            $sub = Join-Path $RawDir "$base.subagents"
            if ((Test-Path $sub) -and -not (Get-ChildItem $sub -Force)) { Remove-Item $sub -Force -ErrorAction SilentlyContinue }
        }
        $analysed += $batch.Count
        $batchesDone++

        if ($failures.Count -gt 0) {
            $problem = "a script was left broken after batch $label"
            Write-Log "Problem: $problem. The next batches are not launched."
            break
        }
    }

    $minutesAll = [int]((Get-Date) - $startAll).TotalMinutes
    Write-Log "Batches done: $batchesDone of $($batches.Count); sessions analysed: $analysed; files deleted: $deleted; kept because rewritten: $kept."

    $left = @(Get-ChildItem -Path $PendDir -Filter '*.md' -File -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -ne 'README.md' })
    if ($left.Count -gt 0) {
        Write-Log "$($left.Count) sessions remain pending for the next run."
    }

    if ($problem) {
        Show-Toast "Weekly improvement incomplete: $problem. $analysed sessions analysed; the rest stays pending."
        Write-Log "=== End with problems ==="
    } else {
        Show-Toast "Weekly improvement done: $analysed sessions in $minutesAll min."
        Write-Log "=== End OK ==="
    }
    exit 0
}
finally {
    Remove-Item $LockDir -Recurse -Force -ErrorAction SilentlyContinue
}
