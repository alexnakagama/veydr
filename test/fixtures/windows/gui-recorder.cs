// A GUI-subsystem program (compiled with /target:winexe by test/integration/windows-commands.test.ts)
// that stands in for an editor such as Code.exe behind code.cmd (add-windows-environment-and-commands
// design D4). It creates no window and no console. It records the arguments it was started with,
// as a JSON array, in the file named by VEYDR_RECORD_FILE (written beside it first, then renamed, so
// a reader never sees half of it), then stays alive for VEYDR_LINGER_MS milliseconds, if set.
using System;
using System.IO;
using System.Text;
using System.Threading;

static class GuiRecorder
{
    static string Json(string text)
    {
        StringBuilder json = new StringBuilder("\"");
        foreach (char c in text)
        {
            if (c == '"' || c == '\\') json.Append('\\').Append(c);
            else if (c < ' ') json.Append("\\u").Append(((int)c).ToString("x4"));
            else json.Append(c);
        }
        return json.Append('"').ToString();
    }

    static int Main()
    {
        string file = Environment.GetEnvironmentVariable("VEYDR_RECORD_FILE");
        if (string.IsNullOrEmpty(file)) return 2;
        string[] args = Environment.GetCommandLineArgs();
        StringBuilder json = new StringBuilder("[");
        for (int i = 1; i < args.Length; i++)
        {
            if (i > 1) json.Append(',');
            json.Append(Json(args[i]));
        }
        json.Append(']');
        string partial = file + ".partial";
        File.WriteAllText(partial, json.ToString(), new UTF8Encoding(false));
        File.Move(partial, file);
        int lingerMs;
        if (int.TryParse(Environment.GetEnvironmentVariable("VEYDR_LINGER_MS"), out lingerMs) && lingerMs > 0) Thread.Sleep(lingerMs);
        return 0;
    }
}
