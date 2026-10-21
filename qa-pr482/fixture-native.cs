// PR482 QA fixture (never product code): a real Windows console-subsystem executable
// standing in for Codex's native binary. Compiled by harness.cjs with the .NET
// Framework csc (C# 5): csc /nologo /target:exe /r:System.Web.Extensions.dll.
// Every mode HOLDS before it answers (milliseconds in hold.txt beside this exe, else
// 1200), so a console window it caused has time to exist while the observer polls.
// Files beside the exe, not environment variables: the login runner scrubs its env.
// Each start appends one JSON line to native-calls.jsonl beside the exe: the harness
// reads it to prove which consumer reached this binary, with which argv, as which pid.
//   app-server ...   JSON-RPC lines on stdin; each request is answered after the hold,
//                    then the process lives until stdin closes (as the real server does)
//   --version        prints a version after the hold
//   login --help     prints usage (no --device-auth) after the hold
//   anything else    prints PR482_MARKER after the hold
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class FixtureNative {
  static int Main(string[] args) {
    string dir = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
    int hold = 1200;
    try { hold = int.Parse(File.ReadAllText(Path.Combine(dir, "hold.txt")).Trim()); } catch (Exception) { }
    var serializer = new JavaScriptSerializer();
    {
      var line = serializer.Serialize(new Dictionary<string, object> {
        { "pid", Process.GetCurrentProcess().Id },
        { "args", args },
        { "at", (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds }
      });
      File.AppendAllText(Path.Combine(dir, "native-calls.jsonl"), line + "\n", new UTF8Encoding(false));
    }
    string joined = " " + string.Join(" ", args) + " ";
    if (Array.IndexOf(args, "app-server") >= 0) {
      string text;
      while ((text = Console.In.ReadLine()) != null) {
        Dictionary<string, object> request;
        try { request = serializer.Deserialize<Dictionary<string, object>>(text); } catch (Exception) { continue; }
        if (request == null || !request.ContainsKey("id")) continue; // notifications get no answer
        Thread.Sleep(hold);
        object method;
        request.TryGetValue("method", out method);
        object result = new Dictionary<string, object>();
        if ("model/list".Equals(method)) {
          result = new Dictionary<string, object> {
            { "data", new object[] { new Dictionary<string, object> {
              { "id", "fixture" }, { "isDefault", true }, { "defaultReasoningEffort", "high" },
              { "supportedReasoningEfforts", new object[] { new Dictionary<string, object> { { "reasoningEffort", "high" } } } }
            } } }
          };
        } else if ("account/rateLimits/read".Equals(method)) {
          result = new Dictionary<string, object> {
            { "rateLimits", new Dictionary<string, object> { { "primary", null }, { "secondary", null } } }
          };
        }
        Console.Out.WriteLine(serializer.Serialize(new Dictionary<string, object> { { "id", request["id"] }, { "result", result } }));
        Console.Out.Flush();
      }
      return 0;
    }
    Thread.Sleep(hold);
    if (Array.IndexOf(args, "--version") >= 0) Console.Out.WriteLine("fixture-cli 1.2.3");
    else if (joined.Contains(" login ") && joined.Contains(" --help ")) Console.Out.WriteLine("Usage: tool login [--with-api-key]");
    else Console.Out.WriteLine(Environment.GetEnvironmentVariable("PR482_MARKER") ?? "native-done");
    Console.Out.Flush();
    return 0;
  }
}
