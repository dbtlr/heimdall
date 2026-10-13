// `launchctl` output captured from macOS on 2026-10-13, as the account the
// Collector runs as (uid 501). Environment blocks are redacted, and home paths
// are generalized to /Users/someone. Indentation is one tab per nesting level,
// as launchctl prints it. These are the shapes the launchd tests are built on.

// `launchctl print gui/501/com.dbtlr.heimdall.collector`, exit 0: a running KeepAlive agent.
export const RUNNING_AGENT = `gui/501/com.dbtlr.heimdall.collector = {
\tactive count = 1
\tpath = /Users/someone/Library/LaunchAgents/com.dbtlr.heimdall.collector.plist
\ttype = LaunchAgent
\tstate = running

\tprogram = /Users/someone/.local/bin/heimdall-collector
\targuments = {
\t\t/Users/someone/.local/bin/heimdall-collector
\t\trun
\t}

\tworking directory = /Users/someone

\tstdout path = /Users/someone/.local/state/heimdall/collector.log
\tstderr path = /Users/someone/.local/state/heimdall/collector.log
\tinherited environment = {
\t\t<redacted>
\t}

\tdefault environment = {
\t\t<redacted>
\t}

\tenvironment = {
\t\t<redacted>
\t}

\tdomain = gui/501 [100002]
\tasid = 100002
\tminimum runtime = 10
\texit timeout = 5
\truns = 4
\tpid = 59099
\timmediate reason = inefficient
\tforks = 10071
\texecs = 1
\tinitialized = 1
\ttrampolined = 1
\tstarted suspended = 0
\tproxy started suspended = 0
\tchecked allocations = 0 (queried = 1)
\tchecked allocations reason = no host
\tchecked allocations flags = 0x0
\tlast exit code = 143

\tresource coalition = {
\t\tID = 213432
\t\ttype = resource
\t\tstate = active
\t\tactive count = 1
\t\tname = com.dbtlr.heimdall.collector
\t}

\tjetsam coalition = {
\t\tID = 213433
\t\ttype = jetsam
\t\tstate = active
\t\tactive count = 1
\t\tname = com.dbtlr.heimdall.collector
\t}

\tspawn type = daemon (3)
\tjetsam priority = 40
\tjetsam memory limit (active) = (unlimited)
\tjetsam memory limit (inactive) = (unlimited)
\tjetsamproperties category = daemon
\tjetsam thread limit = 32
\tcpumon = default

\tproperties = keepalive | runatload | inferred program
}
`;

// `launchctl print gui/501/com.dbtlr.fleet.backup.mimir`, exit 0: a loaded agent with no process, waiting for its schedule.
export const NOT_RUNNING_AGENT = `gui/501/com.dbtlr.fleet.backup.mimir = {
\tactive count = 0
\tpath = /Users/someone/Library/LaunchAgents/com.dbtlr.fleet.backup.mimir.plist
\ttype = LaunchAgent
\tstate = not running

\tprogram = /Users/someone/.local/libexec/fleet-backup-launcher
\targuments = {
\t\t/Users/someone/.local/libexec/fleet-backup-launcher
\t\t/Users/someone/.local/libexec/fleet-backup-mimir
\t}

\tstdout path = /Users/someone/Library/Logs/Fleet/backup-mimir.log
\tstderr path = /Users/someone/Library/Logs/Fleet/backup-mimir.log
\tinherited environment = {
\t\t<redacted>
\t}

\tdefault environment = {
\t\t<redacted>
\t}

\tenvironment = {
\t\t<redacted>
\t}

\tdomain = gui/501 [100002]
\tasid = 100002
\tminimum runtime = 10
\texit timeout = 5
\truns = 4
\tlast exit code = 0

\tevent triggers = {
\t\tcom.dbtlr.fleet.backup.mimir.268435516 => {
\t\t\tkeepalive = 0
\t\t\tservice = com.dbtlr.fleet.backup.mimir
\t\t\tstream = com.apple.launchd.calendarinterval
\t\t\tmonitor = com.apple.UserEventAgent-Aqua
\t\t\tdescriptor = {
\t\t\t\t"Minute" => 0
\t\t\t\t"Hour" => 14
\t\t\t}
\t\t}
\t\tcom.dbtlr.fleet.backup.mimir.268435515 => {
\t\t\tkeepalive = 0
\t\t\tservice = com.dbtlr.fleet.backup.mimir
\t\t\tstream = com.apple.launchd.calendarinterval
\t\t\tmonitor = com.apple.UserEventAgent-Aqua
\t\t\tdescriptor = {
\t\t\t\t"Minute" => 0
\t\t\t\t"Hour" => 2
\t\t\t}
\t\t}
\t}

\tevent channels = {
\t\t"com.apple.launchd.calendarinterval" = {
\t\t\tport = 0x2114b
\t\t\tactive = 0
\t\t\tmanaged = 1
\t\t\treset = 0
\t\t\thide = 0
\t\t\twatching = 1
\t\t}
\t}

\tresource coalition = {
\t\tID = 240349
\t\ttype = resource
\t\tstate = active
\t\tactive count = 1
\t\tname = com.dbtlr.fleet.backup.mimir
\t}

\tjetsam coalition = {
\t\tID = 240350
\t\ttype = jetsam
\t\tstate = active
\t\tactive count = 1
\t\tname = com.dbtlr.fleet.backup.mimir
\t}

\tspawn type = background (5)
\tjetsam priority = 40
\tjetsam memory limit (active) = (unlimited)
\tjetsam memory limit (inactive) = (unlimited)
\tjetsamproperties category = daemon
\tjetsam thread limit = 32
\tcpumon = default

\tproperties = low priority i/o | inferred program
}
`;

// `launchctl print system/com.apple.cfprefsd.xpc.daemon`, exit 0: a daemon, readable without root.
export const SYSTEM_DAEMON = `system/com.apple.cfprefsd.xpc.daemon = {
\tactive count = 2
\tpath = /System/Library/LaunchDaemons/com.apple.cfprefsd.xpc.daemon.plist
\ttype = LaunchDaemon
\tstate = running

\tprogram = /usr/sbin/cfprefsd
\targuments = {
\t\t/usr/sbin/cfprefsd
\t\tdaemon
\t}

\tdefault environment = {
\t\t<redacted>
\t}

\tenvironment = {
\t\t<redacted>
\t}

\tdomain = system
\tminimum runtime = 10
\tbase minimum runtime = 10
\texit timeout = 5
\truns = 1
\tpid = 165
\timmediate reason = ipc (mach)
\tforks = 0
\texecs = 1
\tinitialized = 1
\ttrampolined = 1
\tstarted suspended = 0
\tproxy started suspended = 0
\tchecked allocations = 0 (queried = 1)
\tchecked allocations reason = no host
\tchecked allocations flags = 0x0
\tlast exit code = (never exited)

\tendpoints = {
\t\t"com.apple.cfprefsd.daemon" = {
\t\t\tport = 0x11403
\t\t\tactive = 1
\t\t\tmanaged = 1
\t\t\treset = 0
\t\t\thide = 0
\t\t\twatching = 0
\t\t}
\t}

\tresource coalition = {
\t\tID = 155
\t\ttype = resource
\t\tstate = active
\t\tactive count = 1
\t\tname = com.apple.cfprefsd.xpc.daemon
\t}

\tjetsam coalition = {
\t\tID = 156
\t\ttype = jetsam
\t\tstate = active
\t\tactive count = 1
\t\tname = com.apple.cfprefsd.xpc.daemon
\t}

\tspawn type = adaptive (6)
\tjetsam priority = 40
\tjetsam memory limit (active, soft) = 100 MB
\tjetsam memory limit (inactive, soft) = 100 MB
\tjetsamproperties category = daemon
\tjetsam thread limit = 32
\tcpumon = default
\tresource limits = {
\t\tmaxfiles (soft) => 512
\t\tmaxfiles (hard) => 512
\t}

\texponential throttling grace limit = 10

\tproperties = supports transactions | inferred program | system service | exponential throttling | tle system
}
`;

// `launchctl print gui/501/com.example.heimdall.nonexistent`, exit 113, on stderr.
export const NOT_FOUND_IN_GUI = `Bad request.
Could not find service "com.example.heimdall.nonexistent" in domain for user gui: 501
`;

// `launchctl print system/com.example.heimdall.nonexistent`, exit 113, on stderr.
export const NOT_FOUND_IN_SYSTEM = `Bad request.
Could not find service "com.example.heimdall.nonexistent" in domain for system
`;

// `launchctl print user/501/com.dbtlr.heimdall.collector`, exit 113, on stderr: the user domain is not the GUI domain.
export const NOT_FOUND_IN_USER_DOMAIN = `Bad request.
Could not find service "com.dbtlr.heimdall.collector" in domain for uid: 501
`;

// `launchctl print gui/4242424/com.dbtlr.heimdall.collector`, exit 112, on stderr: a GUI domain that does not exist.
export const NO_GUI_DOMAIN = `Bad request.
Could not find domain for user gui: 4242424
`;
