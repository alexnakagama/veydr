// The Windows process-tree helper (add-windows-process-supervision design D5). One C# 5 file for the
// csc.exe of .NET Framework 4.8, built by scripts/build-windows-helper.mjs and never committed as a
// binary. Subcommands:
//
//   veydr-helper.exe version                      prints the control protocol version on one line
//   veydr-helper.exe run <pipe> <file> [<arg>...]  runs <file> in a Job Object of its own (design D1),
//                                                 controlled over the named pipe <pipe> (design D2)
//
// `run` reads a one-time token as one line on stdin, connects to <pipe>, which must be served by the
// process that started the helper, and proves itself with the token. It then starts <file>, with the
// helper's own working directory and environment, in a new Job Object, and reports over the pipe in
// the JSON lines of protocol version 1 (src/main/platform/windows/protocol.ts). Its stdout and stderr
// belong to the command: the helper never writes to them after it has connected.
//
// Exit codes: 0 the command ran and its job is empty; 1 a failure, reported as an `error` line (or on
// stderr before the pipe is connected), after which nothing of the command is left running; 2 a
// usage error, described on stderr. A `stop` first sends Ctrl+Break to the command's hidden console,
// then ends the job if it has not emptied (design D3). Later groups add `inspect` and `terminate`;
// W3 adds `ports`.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class VeydrHelper
{
    // Version 1 of the JSON-line control protocol (design D2). The TypeScript client refuses a helper
    // whose number differs from its own, so change both together.
    public const int ProtocolVersion = 1;

    public const int ExitOk = 0, ExitFailure = 1, ExitUsage = 2;

    const string Usage = "usage: veydr-helper version | veydr-helper run <pipe> <file> [<arg>...]";

    static int Main()
    {
        string[] args;
        try
        {
            args = Native.CommandLineArguments();
        }
        catch (Win32Exception error)
        {
            Console.Error.WriteLine("veydr-helper: cannot read the command line: " + error.Message);
            return ExitFailure;
        }

        if (args.Length == 1 && args[0] == "version")
        {
            Console.Out.WriteLine(ProtocolVersion.ToString(CultureInfo.InvariantCulture));
            return ExitOk;
        }
        if (args.Length >= 3 && args[0] == "run")
        {
            string[] commandArgs = new string[args.Length - 3];
            Array.Copy(args, 3, commandArgs, 0, commandArgs.Length);
            return new RunCommand(args[1], args[2], commandArgs).Execute();
        }

        Console.Error.WriteLine(Usage);
        return ExitUsage;
    }
}

/** A failure the helper reports and ends on; `Message` is meant for the user. */
sealed class HelperException : Exception
{
    public HelperException(string message) : base(message) { }

    /** The last Win32 error of `what`, e.g. "could not create the job: Access is denied (error 5)". */
    public static HelperException LastError(string what)
    {
        int code = Marshal.GetLastWin32Error();
        return new HelperException(what + ": " + Native.Describe(code));
    }
}

/** A live process of the job, as the protocol reports it. */
sealed class Member
{
    public readonly uint Pid;
    public readonly ulong Created;
    public readonly string Image;

    public Member(uint pid, ulong created, string image)
    {
        Pid = pid;
        Created = created;
        Image = image;
    }
}

/**
 * `veydr-helper run`: one command in one Job Object (design D1), controlled over one authenticated
 * named-pipe connection (design D2). Threads: the main thread starts the command, reports its exit,
 * and waits for the job to empty; a reader thread answers `list` and starts a stop; a port thread
 * reports job changes from the job's completion port; a stop runs on a thread of its own, so `list`
 * is answered while it lasts. Every line is written under `gate`, so lines never interleave, and
 * a `members` list is read and written under it too, so no older list follows a newer one.
 */
sealed class RunCommand
{
    /** Exit code of processes ended by `TerminateJobObject`, as `taskkill /F` uses. */
    const uint KilledExitCode = 1;
    /** How long the forced stop waits for the job to empty (design D3; Linux's KILL_WAIT_MS). */
    const int KillWaitMs = 1000;
    /** How long the helper waits to connect to its control pipe. */
    const int ConnectTimeoutMs = 10000;
    /** Longest accepted token line, and the token's form (64 hex digits from the client). */
    const int MaxTokenBytes = 256;
    static readonly Regex TokenPattern = new Regex("^[0-9a-f]{32,128}$", RegexOptions.CultureInvariant);
    const string PipePrefix = @"\\.\pipe\";
    static readonly Regex PipeNamePattern = new Regex("^[A-Za-z0-9._-]{1,200}$", RegexOptions.CultureInvariant);
    /** Longest accepted control line; Veydr sends only `list` and `stop`. */
    const int MaxControlLineBytes = 4096;
    static readonly Regex ListPattern = new Regex("^\\{\"type\":\"list\"\\}$", RegexOptions.CultureInvariant);
    static readonly Regex StopPattern = new Regex("^\\{\"type\":\"stop\",\"graceMs\":(0|[1-9][0-9]{0,9})\\}$", RegexOptions.CultureInvariant);
    /**
     * A `members` line beyond this many characters is sent without image paths (protocol: 1 MiB).
     * Without them a member takes about 50 characters, so only a job of some 20,000 live processes
     * would still exceed the limit; Veydr then treats the helper as failed, which ends the job.
     */
    const int MaxMembersLineChars = 900 * 1024;
    /**
     * Arguments of a batch file are read by cmd.exe, not by the C runtime. These pass through bare;
     * any other argument is quoted, which makes cmd.exe take `&`, `|`, `<`, `>`, `(`, `)`, `^`,
     * spaces, `=`, `,` and `;` literally (with /v:off, `!` too). What quoting cannot protect is
     * refused: `"` and `%` (expanded even inside quotes), line breaks, NUL, and a trailing backslash,
     * which the program the batch file starts would read as escaping the closing quote. A batch file
     * that turns delayed expansion on itself (`setlocal enabledelayedexpansion`) expands `!` in its
     * arguments again; that is the batch file's own doing, as it would be from any shell.
     */
    static readonly Regex BareBatchArgumentPattern = new Regex("^[A-Za-z0-9_+\\-.:/\\\\@]+$", RegexOptions.CultureInvariant);

    /** How long an abort waits for its `error` line to be written. */
    const int AbortReportMs = 1000;
    /**
     * Most consoles a graceful stop tries to attach to (design D3), so that a job of many processes
     * without a reachable console cannot delay the forced step noticeably.
     */
    const int MaxConsoleAttempts = 64;
    /** Most processes a console may list before it is not trusted to hold only the command's processes. */
    const int MaxConsoleProcesses = 1 << 16;
    /**
     * Keeps Ctrl+C and Ctrl+Break from ending the helper while it is attached to the command's
     * console (design D3). Held in a field so the delegate outlives the native registration.
     */
    static readonly Native.ConsoleCtrlHandler IgnoreBreak = delegate(uint ctrlType)
    {
        return ctrlType == Native.CTRL_C_EVENT || ctrlType == Native.CTRL_BREAK_EVENT;
    };

    readonly string pipePath, file;
    readonly string[] commandArgs;
    readonly object gate = new object();
    NamedPipeClientStream channel;
    /** The channel can no longer be written: Veydr is gone, or the helper is ending. */
    bool channelClosed;
    IntPtr job = IntPtr.Zero, port = IntPtr.Zero, leader = IntPtr.Zero;
    bool exitedReported, stopRequested, terminated;
    /** 1 once the helper is ending, normally or through an abort (see BeginEnding). */
    int ending;
    Thread stopThread;
    string lastEventMembers;
    readonly ManualResetEvent jobEmpty = new ManualResetEvent(false);

    public RunCommand(string pipePath, string file, string[] commandArgs)
    {
        this.pipePath = pipePath;
        this.file = file;
        this.commandArgs = commandArgs;
    }

    public int Execute()
    {
        string token;
        try
        {
            token = ReadToken();
            Connect();
        }
        catch (Exception error)
        {
            // Nothing was started, and the pipe cannot carry the reason.
            Console.Error.WriteLine("veydr-helper: " + error.Message);
            return VeydrHelper.ExitFailure;
        }

        try
        {
            Send("{\"type\":\"ready\",\"version\":" + VeydrHelper.ProtocolVersion.ToString(CultureInfo.InvariantCulture) +
                ",\"token\":" + Json.Quote(token) + ",\"pid\":" + Native.GetCurrentProcessId().ToString(CultureInfo.InvariantCulture) + "}");
            uint leaderPid;
            ulong created;
            StartCommand(out leaderPid, out created);
            Send("{\"type\":\"started\",\"pid\":" + Json.Number(leaderPid) + ",\"created\":\"" + Json.Number(created) + "\"}");

            StartThread(ReadControl, "control");
            StartThread(WatchJob, "job");

            if (Native.WaitForSingleObject(leader, Native.Infinite) != Native.WaitObject0) throw HelperException.LastError("could not wait for the command");
            ReportExited();
            // The helper stays until nothing of the command is left (design D1). Completion-port
            // notifications are not guaranteed, so the count is also read periodically.
            while (ActiveProcesses() != 0) jobEmpty.WaitOne(250);
        }
        catch (Exception error)
        {
            Abort(error is HelperException ? error.Message : "unexpected failure: " + error.Message);
            // Abort returns only while another thread's abort is under way; that one reports and exits.
            Thread.Sleep(Timeout.Infinite);
            return VeydrHelper.ExitFailure;
        }

        if (!BeginEnding())
        {
            // An abort is under way on another thread, and it exits the process.
            Thread.Sleep(Timeout.Infinite);
        }
        Thread pendingStop;
        lock (gate) pendingStop = stopThread;
        // A stop that began before the job emptied still reports its result.
        if (pendingStop != null) pendingStop.Join();
        lock (gate)
        {
            channelClosed = true;
            channel.Dispose();
        }
        return VeydrHelper.ExitOk;
    }

    /** Marks the helper as ending; `false` if it already was. Lock-free, so an abort never waits on a writer. */
    bool BeginEnding()
    {
        return Interlocked.CompareExchange(ref ending, 1, 0) == 0;
    }

    bool IsEnding()
    {
        return Thread.VolatileRead(ref ending) != 0;
    }

    static void StartThread(ThreadStart body, string name)
    {
        Thread thread = new Thread(body);
        thread.IsBackground = true;
        thread.Name = name;
        thread.Start();
    }

    /**
     * The helper cannot go on: it ends the job, and with it every process of the command (design
     * D1), reports why if it still can, and exits with 1. Only the first call acts; once the helper
     * is ending normally, later failures change nothing. The job is ended before anything that could
     * block, and the report gets at most AbortReportMs.
     */
    void Abort(string message)
    {
        if (!BeginEnding()) return;
        if (job != IntPtr.Zero) Native.TerminateJobObject(job, KilledExitCode);
        else if (leader != IntPtr.Zero) Native.TerminateProcess(leader, KilledExitCode);
        Thread report = new Thread(delegate()
        {
            Write("{\"type\":\"error\",\"message\":" + Json.Quote(Truncate(message, 4000)) + "}");
        });
        report.IsBackground = true;
        report.Start();
        report.Join(AbortReportMs);
        Environment.Exit(VeydrHelper.ExitFailure);
    }

    static string Truncate(string text, int length)
    {
        return text.Length <= length ? text : text.Substring(0, length);
    }

    // ---- Control channel ------------------------------------------------------------------------

    /** The token Veydr wrote as one line on stdin (design D2): it never appears on a command line. */
    static string ReadToken()
    {
        Stream stdin = Console.OpenStandardInput();
        byte[] bytes = new byte[MaxTokenBytes];
        int length = 0;
        while (true)
        {
            int next = stdin.ReadByte();
            if (next == -1 || next == '\n') break;
            if (length == bytes.Length) throw new HelperException("the token line on stdin is too long");
            bytes[length++] = (byte)next;
        }
        if (length > 0 && bytes[length - 1] == '\r') length--;
        string token = Encoding.ASCII.GetString(bytes, 0, length);
        if (!TokenPattern.IsMatch(token)) throw new HelperException("no valid token on stdin");
        return token;
    }

    /**
     * Connects to the control pipe, which must be served by the process that started the helper:
     * the pipe name is on the command line, where any process of the same user can read it, so
     * another process could otherwise offer an instance of its own. The connection is anonymous, so
     * the server cannot act with the helper's identity.
     */
    void Connect()
    {
        if (!pipePath.StartsWith(PipePrefix, StringComparison.OrdinalIgnoreCase)) throw new HelperException("the control pipe must be a local named pipe: " + pipePath);
        string name = pipePath.Substring(PipePrefix.Length);
        if (!PipeNamePattern.IsMatch(name)) throw new HelperException("the control pipe name is not valid: " + pipePath);

        channel = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Anonymous);
        try
        {
            channel.Connect(ConnectTimeoutMs);
        }
        catch (TimeoutException)
        {
            throw new HelperException("could not connect to the control pipe within " + ConnectTimeoutMs + " ms");
        }
        catch (IOException error)
        {
            throw new HelperException("could not connect to the control pipe: " + error.Message);
        }

        uint server;
        if (!Native.GetNamedPipeServerProcessId(channel.SafePipeHandle, out server)) throw HelperException.LastError("could not identify the control pipe's server");
        uint parent = Native.ParentProcessId();
        if (server != parent)
        {
            throw new HelperException("the control pipe is served by process " + server + ", not by the helper's parent " + parent);
        }
    }

    /** Writes one line unless the channel is closed; `false` if it could not be written. */
    bool Write(string json)
    {
        lock (gate)
        {
            if (channelClosed) return false;
            byte[] bytes = Encoding.ASCII.GetBytes(json + "\n");
            try
            {
                channel.Write(bytes, 0, bytes.Length);
                channel.Flush();
                return true;
            }
            catch (Exception error)
            {
                if (!(error is IOException || error is ObjectDisposedException || error is InvalidOperationException)) throw;
                channelClosed = true;
                return false;
            }
        }
    }

    /** Writes one line; a channel that fails means Veydr is gone, and the command must not outlive it. */
    void Send(string json)
    {
        if (Write(json) || IsEnding()) return;
        throw new HelperException("the control channel closed");
    }

    /** Reads Veydr's lines: `list` is answered at once, in order, and `stop` starts the stop (design D2). */
    void ReadControl()
    {
        try
        {
            byte[] buffer = new byte[4096];
            MemoryStream line = new MemoryStream();
            while (true)
            {
                int read;
                try
                {
                    read = channel.Read(buffer, 0, buffer.Length);
                }
                catch (Exception)
                {
                    // A broken or closed pipe; disposed by the helper itself once it is ending.
                    read = 0;
                }
                if (read == 0)
                {
                    if (IsEnding()) return;
                    throw new HelperException("the control channel closed before the command ended");
                }
                for (int i = 0; i < read; i++)
                {
                    if (buffer[i] != '\n')
                    {
                        if (line.Length >= MaxControlLineBytes) throw new HelperException("a control line is too long");
                        line.WriteByte(buffer[i]);
                        continue;
                    }
                    string text = Encoding.ASCII.GetString(line.GetBuffer(), 0, (int)line.Length);
                    line.SetLength(0);
                    if (text.EndsWith("\r", StringComparison.Ordinal)) text = text.Substring(0, text.Length - 1);
                    HandleControl(text);
                }
            }
        }
        catch (Exception error)
        {
            Abort(error is HelperException ? error.Message : "unexpected failure: " + error.Message);
        }
    }

    void HandleControl(string text)
    {
        if (ListPattern.IsMatch(text))
        {
            SendMembers(true);
            return;
        }
        Match stop = StopPattern.Match(text);
        if (!stop.Success) throw new HelperException("unknown control line: " + Truncate(text, 200));
        long graceMs = long.Parse(stop.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture);
        if (graceMs > int.MaxValue) throw new HelperException("graceMs is out of range: " + graceMs);
        lock (gate)
        {
            // Veydr sends `stop` at most once per run; a stop after the helper began to end finds
            // nothing left to stop.
            if (stopRequested || IsEnding()) return;
            stopRequested = true;
            int grace = (int)graceMs;
            stopThread = new Thread(delegate() { RunStop(grace); });
            stopThread.IsBackground = true;
            stopThread.Name = "stop";
            stopThread.Start();
        }
    }

    // ---- Job and command ------------------------------------------------------------------------

    /**
     * Starts the command suspended in a new console of its own, hidden, assigns it to a new job with
     * KILL_ON_JOB_CLOSE and no breakaway, and only then resumes it, so every process it starts is in
     * the job from its first instruction on (design D1). The command inherits exactly the helper's
     * stdout and stderr and a NUL stdin (design D2).
     */
    void StartCommand(out uint leaderPid, out ulong created)
    {
        string application, commandLine;
        BuildCommandLine(out application, out commandLine);

        job = Native.CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw HelperException.LastError("could not create the job");
        Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        // Neither BREAKAWAY_OK nor SILENT_BREAKAWAY_OK: no process of the command can leave the job.
        limits.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            throw HelperException.LastError("could not configure the job");

        port = Native.CreateIoCompletionPort(Native.InvalidHandle, IntPtr.Zero, UIntPtr.Zero, 1);
        if (port == IntPtr.Zero) throw HelperException.LastError("could not create the job's completion port");
        Native.JOBOBJECT_ASSOCIATE_COMPLETION_PORT association = new Native.JOBOBJECT_ASSOCIATE_COMPLETION_PORT();
        association.CompletionKey = job;
        association.CompletionPort = port;
        if (!Native.SetInformationJobObject(job, Native.JobObjectAssociateCompletionPortInformation, ref association, Marshal.SizeOf(typeof(Native.JOBOBJECT_ASSOCIATE_COMPLETION_PORT))))
            throw HelperException.LastError("could not watch the job");

        IntPtr stdout = Native.GetStdHandle(Native.STD_OUTPUT_HANDLE);
        IntPtr stderr = Native.GetStdHandle(Native.STD_ERROR_HANDLE);
        if (stdout == IntPtr.Zero || stdout == Native.InvalidHandle || stderr == IntPtr.Zero || stderr == Native.InvalidHandle)
            throw new HelperException("the helper has no stdout or stderr to give the command");
        // Only inheritable handles may be listed; nothing else is inherited.
        if (!Native.SetHandleInformation(stdout, Native.HANDLE_FLAG_INHERIT, Native.HANDLE_FLAG_INHERIT) ||
            !Native.SetHandleInformation(stderr, Native.HANDLE_FLAG_INHERIT, Native.HANDLE_FLAG_INHERIT))
            throw HelperException.LastError("could not pass the output handles on");

        Native.SECURITY_ATTRIBUTES inheritable = new Native.SECURITY_ATTRIBUTES();
        inheritable.nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES));
        inheritable.bInheritHandle = true;
        IntPtr nul = Native.CreateFile("NUL", Native.GENERIC_READ, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, ref inheritable, Native.OPEN_EXISTING, 0, IntPtr.Zero);
        if (nul == Native.InvalidHandle) throw HelperException.LastError("could not open NUL for the command's stdin");

        IntPtr handles = IntPtr.Zero, attributes = IntPtr.Zero;
        bool attributesReady = false;
        Native.PROCESS_INFORMATION process = new Native.PROCESS_INFORMATION();
        try
        {
            IntPtr[] list = stdout == stderr ? new IntPtr[] { nul, stdout } : new IntPtr[] { nul, stdout, stderr };
            handles = Marshal.AllocHGlobal(IntPtr.Size * list.Length);
            Marshal.Copy(list, 0, handles, list.Length);

            IntPtr size = IntPtr.Zero;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (size == IntPtr.Zero) throw HelperException.LastError("could not size the process attributes");
            attributes = Marshal.AllocHGlobal(size);
            if (!Native.InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw HelperException.LastError("could not create the process attributes");
            attributesReady = true;
            if (!Native.UpdateProcThreadAttribute(attributes, 0, (IntPtr)Native.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, (IntPtr)(IntPtr.Size * list.Length), IntPtr.Zero, IntPtr.Zero))
                throw HelperException.LastError("could not limit the inherited handles");

            Native.STARTUPINFOEX startup = new Native.STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
            startup.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES | Native.STARTF_USESHOWWINDOW;
            startup.StartupInfo.wShowWindow = Native.SW_HIDE;
            startup.StartupInfo.hStdInput = nul;
            startup.StartupInfo.hStdOutput = stdout;
            startup.StartupInfo.hStdError = stderr;
            startup.lpAttributeList = attributes;

            // The working directory and environment are the helper's own, which Veydr set (design D2).
            uint flags = Native.CREATE_SUSPENDED | Native.CREATE_NEW_CONSOLE | Native.CREATE_NEW_PROCESS_GROUP | Native.CREATE_UNICODE_ENVIRONMENT | Native.EXTENDED_STARTUPINFO_PRESENT;
            if (!Native.CreateProcess(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, null, ref startup, out process))
            {
                int code = Marshal.GetLastWin32Error();
                throw new HelperException(Native.Describe(code));
            }
        }
        finally
        {
            if (attributesReady) Native.DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            Native.CloseHandle(nul);
        }

        leader = process.hProcess;
        try
        {
            if (!Native.AssignProcessToJobObject(job, process.hProcess)) throw HelperException.LastError("could not put the command in its job");
            if (Native.ResumeThread(process.hThread) == uint.MaxValue) throw HelperException.LastError("could not resume the command");
        }
        catch
        {
            // Still suspended, or in the job: either way nothing of it may keep running.
            Native.TerminateProcess(process.hProcess, KilledExitCode);
            throw;
        }
        finally
        {
            Native.CloseHandle(process.hThread);
        }
        long creation, exit, kernel, user;
        if (!Native.GetProcessTimes(process.hProcess, out creation, out exit, out kernel, out user)) throw HelperException.LastError("could not read the command's creation time");
        leaderPid = process.dwProcessId;
        created = (ulong)creation;
    }

    /**
     * The program to start and its command line, quoted for CommandLineToArgvW and the C runtime
     * (the rules libuv quotes the helper's own arguments by). A batch file runs under cmd.exe, which
     * CreateProcess would otherwise start implicitly with arguments it does not quote safely.
     */
    void BuildCommandLine(out string application, out string commandLine)
    {
        if (!IsFullyQualified(file)) throw new HelperException("the program must be given by its full path: " + file);
        if (file.IndexOf('"') >= 0 || file.IndexOf('\0') >= 0) throw new HelperException("the program path contains a character that is not allowed: " + file);
        StringBuilder line = new StringBuilder();
        if (IsBatchFile(file))
        {
            // cmd.exe expands %variables% even inside quotes, so such a path is refused.
            if (file.IndexOf('%') >= 0) throw new HelperException("a batch file path must not contain %: " + file);
            application = Path.Combine(Environment.SystemDirectory, "cmd.exe");
            // /d: no AutoRun commands; /v:off: no !delayed! expansion; /s /c "...": the outer quotes are stripped.
            line.Append("cmd.exe /d /e:on /v:off /s /c \"\"").Append(file).Append('"');
            foreach (string arg in commandArgs) line.Append(' ').Append(BatchArgument(arg));
            line.Append('"');
        }
        else
        {
            application = file;
            // argv[0] is read up to its closing quote, without escapes; the path contains no quote.
            line.Append('"').Append(file).Append('"');
            foreach (string arg in commandArgs)
            {
                if (arg.IndexOf('\0') >= 0) throw new HelperException("an argument contains a NUL character");
                line.Append(' ');
                AppendQuoted(line, arg);
            }
        }
        // CreateProcess limits the command line to 32767 characters, its terminating NUL included.
        if (line.Length >= 32767) throw new HelperException("the command line is too long (" + line.Length + " characters)");
        commandLine = line.ToString();
    }

    /** `arg` as cmd.exe passes it on literally, quoted where needed (see BareBatchArgumentPattern). */
    static string BatchArgument(string arg)
    {
        if (BareBatchArgumentPattern.IsMatch(arg)) return arg;
        if (arg.IndexOfAny(new char[] { '"', '%', '\r', '\n', '\0' }) >= 0 || arg.EndsWith("\\", StringComparison.Ordinal))
            throw new HelperException("a batch file argument contains a character cmd.exe cannot be given safely (\", %, a line break, or a trailing \\): " + Truncate(arg, 200));
        return "\"" + arg + "\"";
    }

    static bool IsFullyQualified(string path)
    {
        if (path.Length >= 3 && char.IsLetter(path[0]) && path[1] == ':' && (path[2] == '\\' || path[2] == '/')) return true;
        return path.Length >= 3 && (path[0] == '\\' || path[0] == '/') && (path[1] == '\\' || path[1] == '/');
    }

    static bool IsBatchFile(string path)
    {
        int separator = Math.Max(path.LastIndexOf('\\'), path.LastIndexOf('/'));
        string name = path.Substring(separator + 1).TrimEnd(' ', '.');
        return name.EndsWith(".bat", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase);
    }

    /** Appends `arg` so that CommandLineToArgvW and the C runtime read it back unchanged. */
    static void AppendQuoted(StringBuilder line, string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            line.Append(arg);
            return;
        }
        line.Append('"');
        for (int i = 0; ; i++)
        {
            int backslashes = 0;
            while (i < arg.Length && arg[i] == '\\')
            {
                i++;
                backslashes++;
            }
            if (i == arg.Length)
            {
                // Doubled, so the closing quote stays a quote.
                line.Append('\\', backslashes * 2);
                break;
            }
            if (arg[i] == '"') line.Append('\\', backslashes * 2 + 1).Append('"');
            else line.Append('\\', backslashes).Append(arg[i]);
        }
        line.Append('"');
    }

    uint ActiveProcesses()
    {
        Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
        if (!Native.QueryInformationJobObject(job, Native.JobObjectBasicAccountingInformation, out info, Marshal.SizeOf(typeof(Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero))
            throw HelperException.LastError("could not count the job's processes");
        return info.ActiveProcesses;
    }

    /** PIDs in the job, nested jobs included. */
    uint[] JobPids()
    {
        int capacity = 64;
        for (int attempt = 0; attempt < 16; attempt++)
        {
            int size = 8 + capacity * IntPtr.Size;
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                if (Native.QueryInformationJobObject(job, Native.JobObjectBasicProcessIdList, buffer, size, IntPtr.Zero))
                {
                    int count = Marshal.ReadInt32(buffer, 4);
                    uint[] pids = new uint[count];
                    for (int i = 0; i < count; i++) pids[i] = (uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
                    return pids;
                }
                int code = Marshal.GetLastWin32Error();
                if (code != Native.ERROR_MORE_DATA) throw new HelperException("could not list the job's processes: " + Native.Describe(code));
                int assigned = Marshal.ReadInt32(buffer, 0);
                capacity = Math.Max(capacity * 2, assigned + 64);
                if (capacity > 1 << 20) throw new HelperException("the job holds too many processes to list");
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        throw new HelperException("could not list the job's processes: the job kept growing");
    }

    /**
     * The live processes of the job, oldest first. Each PID is opened and checked to be in this job,
     * so a PID reused after the list was read is never reported.
     */
    List<Member> Members()
    {
        List<Member> members = new List<Member>();
        foreach (uint pid in JobPids())
        {
            IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION | Native.SYNCHRONIZE, false, pid);
            if (process == IntPtr.Zero) continue;
            try
            {
                bool inJob;
                if (!Native.IsProcessInJob(process, job, out inJob) || !inJob) continue;
                if (Native.WaitForSingleObject(process, 0) != Native.WaitTimeout) continue;
                long creation, exit, kernel, user;
                if (!Native.GetProcessTimes(process, out creation, out exit, out kernel, out user) || creation <= 0) continue;
                members.Add(new Member(pid, (ulong)creation, Native.ImagePath(process)));
            }
            finally
            {
                Native.CloseHandle(process);
            }
        }
        members.Sort(delegate(Member a, Member b)
        {
            int byAge = a.Created.CompareTo(b.Created);
            return byAge != 0 ? byAge : a.Pid.CompareTo(b.Pid);
        });
        return members;
    }

    static string MembersJson(List<Member> members, bool withImages)
    {
        StringBuilder json = new StringBuilder("[");
        for (int i = 0; i < members.Count; i++)
        {
            Member m = members[i];
            if (i > 0) json.Append(',');
            json.Append("{\"pid\":").Append(Json.Number(m.Pid)).Append(",\"created\":\"").Append(Json.Number(m.Created))
                .Append("\",\"image\":").Append(Json.Quote(withImages ? m.Image : ""));
            json.Append('}');
        }
        return json.Append(']').ToString();
    }

    static string MembersJson(List<Member> members)
    {
        string full = MembersJson(members, true);
        return full.Length <= MaxMembersLineChars ? full : MembersJson(members, false);
    }

    /** Reads the members and sends them as one `members` line; `answer` for a `list` (design D2). */
    void SendMembers(bool answer)
    {
        lock (gate)
        {
            string list = MembersJson(Members());
            if (!answer)
            {
                // The same set again tells Veydr nothing.
                if (list == lastEventMembers) return;
                lastEventMembers = list;
            }
            Send("{\"type\":\"members\",\"answer\":" + (answer ? "true" : "false") + ",\"members\":" + list + "}");
        }
    }

    /** Reports job changes from the completion port (design D2). */
    void WatchJob()
    {
        try
        {
            while (true)
            {
                uint message;
                UIntPtr key;
                IntPtr overlapped;
                if (!Native.GetQueuedCompletionStatus(port, out message, out key, out overlapped, Native.Infinite))
                    throw HelperException.LastError("could not read the job's completion port");
                switch (message)
                {
                    case Native.JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO:
                        jobEmpty.Set();
                        break;
                    case Native.JOB_OBJECT_MSG_NEW_PROCESS:
                    case Native.JOB_OBJECT_MSG_EXIT_PROCESS:
                    case Native.JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS:
                        SendMembers(false);
                        break;
                }
            }
        }
        catch (Exception error)
        {
            Abort(error is HelperException ? error.Message : "unexpected failure: " + error.Message);
        }
    }

    /** Sends `exited` once the leader has ended, exactly once. */
    void ReportExited()
    {
        lock (gate)
        {
            if (exitedReported || Native.WaitForSingleObject(leader, 0) != Native.WaitObject0) return;
            uint code;
            if (!Native.GetExitCodeProcess(leader, out code)) throw HelperException.LastError("could not read the command's exit code");
            exitedReported = true;
            Send("{\"type\":\"exited\",\"code\":" + Json.Number(code) + ",\"forced\":" + (terminated ? "true" : "false") + "}");
        }
    }

    void RunStop(int graceMs)
    {
        try
        {
            Stop(graceMs);
        }
        catch (Exception error)
        {
            Abort(error is HelperException ? error.Message : "unexpected failure: " + error.Message);
        }
    }

    /**
     * The stop (design D3): Ctrl+Break to the command's console, then up to `graceMs` for the job to
     * empty; if it has not, `TerminateJobObject` and up to 1 s more. When no event could be sent, the
     * forced step follows at once, without waiting `graceMs`. A `stopped` report then names the
     * members still alive; `graceful` is "yes" only when the job emptied before any forced step. A
     * job that is already empty needed no stop.
     */
    void Stop(int graceMs)
    {
        string graceful = "yes";
        bool forced = false;
        if (ActiveProcesses() != 0 && !(SendCtrlBreak() && WaitForEmptyJob(graceMs)))
        {
            lock (gate) terminated = true;
            graceful = "no";
            forced = true;
            // Should this fail, what is left is reported as surviving, and the job still ends it
            // once the helper exits (KILL_ON_JOB_CLOSE).
            Native.TerminateJobObject(job, KilledExitCode);
            WaitForEmptyJob(KillWaitMs);
        }
        // Once the job is empty the leader has ended, but its handle may be signalled a moment later.
        if (ActiveProcesses() == 0) Native.WaitForSingleObject(leader, KillWaitMs);

        lock (gate)
        {
            List<Member> survivors = Members();
            bool leaderAlive = Native.WaitForSingleObject(leader, 0) != Native.WaitObject0;
            if (leaderAlive)
            {
                uint leaderPid = Native.GetProcessId(leader);
                bool listed = false;
                foreach (Member m in survivors) listed |= m.Pid == leaderPid;
                // `exited` precedes a complete stop, so a leader still alive is always a survivor.
                if (!listed)
                {
                    long creation, exit, kernel, user;
                    if (!Native.GetProcessTimes(leader, out creation, out exit, out kernel, out user)) throw HelperException.LastError("could not read the command's creation time");
                    survivors.Insert(0, new Member(leaderPid, (ulong)creation, Native.ImagePath(leader)));
                }
            }
            else
            {
                ReportExited();
            }
            Send("{\"type\":\"stopped\",\"graceful\":\"" + graceful + "\",\"forced\":" + (forced ? "true" : "false") + ",\"survivors\":" + MembersJson(survivors) + "}");
        }
    }

    /** Waits up to `timeoutMs` for the job to empty; `true` if it did. */
    bool WaitForEmptyJob(int timeoutMs)
    {
        Stopwatch elapsed = Stopwatch.StartNew();
        while (ActiveProcesses() != 0)
        {
            long left = timeoutMs - elapsed.ElapsedMilliseconds;
            if (left <= 0) return false;
            // ACTIVE_PROCESS_ZERO wakes the wait early; the count is read again either way, since
            // completion-port notifications are not guaranteed. jobEmpty is never reset: should it
            // be set while the job is not empty, the short sleep keeps this from spinning.
            if (jobEmpty.WaitOne((int)Math.Min(left, 50))) Thread.Sleep((int)Math.Min(left, 10));
        }
        return true;
    }

    /**
     * Sends Ctrl+Break to the command's hidden console (design D3): the console of the leader, or,
     * once the leader has ended, of the oldest live member that has one. The event reaches every
     * process on that console, so it is sent only to a console that holds nothing but this job's
     * processes; Veydr and other commands have consoles of their own and are never reached. `false`
     * when no such console could be attached to, or the event could not be sent: then no process
     * of the command can receive it, and waiting `graceMs` would gain nothing.
     *
     * Only the stop thread changes the helper's console, and a run has at most one stop.
     */
    bool SendCtrlBreak()
    {
        // Ctrl+C for good measure; a NULL handler does not cover Ctrl+Break, which IgnoreBreak does.
        if (!Native.SetConsoleCtrlHandler(null, true) || !Native.SetConsoleCtrlHandler(IgnoreBreak, true)) return false;
        // The helper's own console (Veydr's, or a hidden one of its own): AttachConsole refuses a
        // second one. The helper writes nothing to a console, so it never needs it back.
        Native.FreeConsole();

        // At most MaxConsoleAttempts entries, so a list is enough (and needs only mscorlib).
        List<IntPtr> triedConsoles = new List<IntPtr>();
        int attempts = 0;
        foreach (Member member in Members())
        {
            if (attempts++ == MaxConsoleAttempts) break;
            // Fails for a process without a console, such as one that called FreeConsole or a
            // console host, and for one that has exited since it was listed.
            if (!Native.AttachConsole(member.Pid)) continue;
            try
            {
                IntPtr window = Native.GetConsoleWindow();
                // A console seen before was already found unfit; a console without a window
                // cannot be told apart from another, so it is always checked.
                if (window != IntPtr.Zero)
                {
                    if (triedConsoles.Contains(window)) continue;
                    triedConsoles.Add(window);
                }
                if (!ConsoleHoldsOnlyJobMembers()) continue;
                if (Native.GenerateConsoleCtrlEvent(Native.CTRL_BREAK_EVENT, 0)) return true;
            }
            finally
            {
                Native.FreeConsole();
            }
        }
        return false;
    }

    /**
     * Whether every process on the console the helper is attached to, apart from the helper, is in
     * this job, and there is at least one. A process that cannot be opened counts as foreign.
     */
    bool ConsoleHoldsOnlyJobMembers()
    {
        uint self = Native.GetCurrentProcessId();
        uint[] list = new uint[64];
        while (true)
        {
            uint count = Native.GetConsoleProcessList(list, (uint)list.Length);
            if (count == 0 || count > MaxConsoleProcesses) return false;
            if (count > list.Length)
            {
                // More processes than room; ask again with enough, as the list may still grow.
                list = new uint[count + 16];
                continue;
            }
            bool anyMember = false;
            for (int i = 0; i < count; i++)
            {
                if (list[i] == self) continue;
                if (!IsJobMember(list[i])) return false;
                anyMember = true;
            }
            return anyMember;
        }
    }

    bool IsJobMember(uint pid)
    {
        IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) return false;
        try
        {
            bool inJob;
            return Native.IsProcessInJob(process, job, out inJob) && inJob;
        }
        finally
        {
            Native.CloseHandle(process);
        }
    }
}

/** Just enough JSON for the protocol's lines, as ASCII: everything else is escaped. */
static class Json
{
    public static string Number(ulong value)
    {
        return value.ToString(CultureInfo.InvariantCulture);
    }

    public static string Quote(string text)
    {
        StringBuilder json = new StringBuilder(text.Length + 2);
        json.Append('"');
        foreach (char c in text)
        {
            if (c == '"') json.Append("\\\"");
            else if (c == '\\') json.Append("\\\\");
            else if (c >= 0x20 && c < 0x7f) json.Append(c);
            // Control characters, non-ASCII, and unpaired surrogates alike.
            else json.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
        }
        return json.Append('"').ToString();
    }
}

static class Native
{
    public const uint Infinite = 0xFFFFFFFF;
    public const uint WaitObject0 = 0, WaitTimeout = 0x102;
    public static readonly IntPtr InvalidHandle = new IntPtr(-1);
    public const int ERROR_MORE_DATA = 234;

    public const uint CREATE_SUSPENDED = 0x4, CREATE_NEW_CONSOLE = 0x10, CREATE_NEW_PROCESS_GROUP = 0x200;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x400, EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    public const int STARTF_USESHOWWINDOW = 0x1, STARTF_USESTDHANDLES = 0x100;
    public const short SW_HIDE = 0;
    public const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002;
    public const int STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
    public const uint HANDLE_FLAG_INHERIT = 0x1;
    public const uint GENERIC_READ = 0x80000000, FILE_SHARE_READ = 0x1, FILE_SHARE_WRITE = 0x2, OPEN_EXISTING = 3;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, SYNCHRONIZE = 0x100000;

    public const int JobObjectBasicAccountingInformation = 1, JobObjectBasicProcessIdList = 3;
    public const int JobObjectAssociateCompletionPortInformation = 7, JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const uint JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO = 4, JOB_OBJECT_MSG_NEW_PROCESS = 6;
    public const uint JOB_OBJECT_MSG_EXIT_PROCESS = 7, JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS = 8;
    public const uint CTRL_C_EVENT = 0, CTRL_BREAK_EVENT = 1;

    /** A console control handler: `true` if it handled `ctrlType`. */
    public delegate bool ConsoleCtrlHandler(uint ctrlType);

    // Interop structures: their fields are written by Windows, not by this code.
#pragma warning disable 0649, 0169
    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT
    {
        public IntPtr CompletionKey, CompletionPort;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus, PebBaseAddress;
        public UIntPtr AffinityMask;
        public IntPtr BasePriority;
        public UIntPtr UniqueProcessId, InheritedFromUniqueProcessId;
    }
#pragma warning restore 0649, 0169

    [DllImport("kernel32.dll")] public static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] public static extern IntPtr GetCommandLineW();
    [DllImport("shell32.dll", SetLastError = true)] public static extern IntPtr CommandLineToArgvW(IntPtr commandLine, out int count);
    [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr process, int infoClass, out PROCESS_BASIC_INFORMATION info, int length, out int returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint serverProcessId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_ASSOCIATE_COMPLETION_PORT info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existingPort, UIntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes, out UIntPtr key, out IntPtr overlapped, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
    [DllImport("kernel32.dll")] public static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint processId);
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetConsoleProcessList([Out] uint[] processList, uint processCount);

    /** A Win32 error as "<system message> (error <code>)". */
    public static string Describe(int code)
    {
        return new Win32Exception(code).Message + " (error " + code.ToString(CultureInfo.InvariantCulture) + ")";
    }

    /** The helper's arguments, split by CommandLineToArgvW: the rules libuv quotes them by. */
    public static string[] CommandLineArguments()
    {
        int count;
        IntPtr argv = CommandLineToArgvW(GetCommandLineW(), out count);
        if (argv == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            // argv[0] is the helper itself.
            string[] args = new string[Math.Max(count - 1, 0)];
            for (int i = 1; i < count; i++) args[i - 1] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
            return args;
        }
        finally
        {
            LocalFree(argv);
        }
    }

    /** The PID of the process that created this one. */
    public static uint ParentProcessId()
    {
        PROCESS_BASIC_INFORMATION info;
        int length;
        int status = NtQueryInformationProcess(GetCurrentProcess(), 0, out info, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out length);
        if (status != 0) throw new HelperException("could not identify the helper's parent process (status 0x" + status.ToString("x8", CultureInfo.InvariantCulture) + ")");
        return (uint)info.InheritedFromUniqueProcessId.ToUInt64();
    }

    /** The full image path of `process`, or "" if it cannot be read. */
    public static string ImagePath(IntPtr process)
    {
        StringBuilder name = new StringBuilder(32768);
        int size = name.Capacity;
        return QueryFullProcessImageName(process, 0, name, ref size) ? name.ToString(0, size) : "";
    }
}
