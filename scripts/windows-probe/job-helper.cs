// The minimal helper of gate G-4 option C (design D2), compiled during the probe by the csc.exe of
// .NET Framework 4.8 (C# 5) and never committed as a binary:
//
//   job-helper.exe <ready-file> <application> <command line>
//
// It creates a Job Object, starts the program suspended, assigns it to the job and resumes it, so
// everything the program starts is in the job. Once <ready-file> exists (the program has started its
// own child) it terminates the job and waits until the job is empty. It prints one JSON line:
// { "inJob": bool, "childExitCode": n, "activeProcesses": n }.
// Exit codes: 0 the job ended the program; 1 a failure, described on stderr.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class JobHelper
{
    const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000;
    const uint WAIT_OBJECT_0 = 0;
    const int JobObjectBasicAccountingInformation = 1;
    const int ReadyTimeoutMs = 60000, EmptyTimeoutMs = 10000, PollMs = 50;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int length, IntPtr returnLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    static Win32Exception LastError()
    {
        return new Win32Exception(Marshal.GetLastWin32Error());
    }

    static uint ActiveProcesses(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero))
            throw LastError();
        return info.ActiveProcesses;
    }

    static void Run(string readyFile, string application, string commandLine)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw LastError();

        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION process;
        if (!CreateProcess(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_NO_WINDOW,
                IntPtr.Zero, null, ref startup, out process))
            throw LastError();

        bool assigned = false;
        try
        {
            if (!AssignProcessToJobObject(job, process.hProcess)) throw LastError();
            assigned = true;
            bool inJob;
            if (!IsProcessInJob(process.hProcess, job, out inJob)) throw LastError();
            if (ResumeThread(process.hThread) == 0xFFFFFFFF) throw LastError();

            for (int waited = 0; !File.Exists(readyFile); waited += PollMs)
            {
                if (waited >= ReadyTimeoutMs) throw new TimeoutException(readyFile + " did not appear within " + ReadyTimeoutMs / 1000 + " s");
                Thread.Sleep(PollMs);
            }

            if (!TerminateJobObject(job, 1)) throw LastError();
            if (WaitForSingleObject(process.hProcess, (uint)EmptyTimeoutMs) != WAIT_OBJECT_0) throw new TimeoutException("the child did not end");
            uint active = ActiveProcesses(job);
            for (int waited = 0; active != 0 && waited < EmptyTimeoutMs; waited += PollMs)
            {
                Thread.Sleep(PollMs);
                active = ActiveProcesses(job);
            }
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw LastError();
            Console.WriteLine("{{\"inJob\":{0},\"childExitCode\":{1},\"activeProcesses\":{2}}}", inJob ? "true" : "false", exitCode, active);
            if (active != 0) throw new InvalidOperationException("the job still holds " + active + " processes");
        }
        finally
        {
            // Nothing outlives a failed helper: the job ends what it holds, and an unassigned child ends here.
            if (assigned) TerminateJobObject(job, 1);
            else TerminateProcess(process.hProcess, 1);
        }
    }

    static int Main(string[] args)
    {
        if (args.Length != 3)
        {
            Console.Error.WriteLine("usage: job-helper.exe <ready-file> <application> <command line>");
            return 1;
        }
        try
        {
            Run(args[0], args[1], args[2]);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("job-helper: " + error.Message);
            return 1;
        }
    }
}
