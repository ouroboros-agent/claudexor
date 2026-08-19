import { describe, expect, it } from "vitest";
import {
  dumpbinDependencyBasenames,
  dynamicCrtDependencies,
  sanitizedMsvcEnvironment,
} from "./win32-msvc-runtime.mjs";

describe("Win32 MSVC runtime build contract", () => {
  it("removes inherited compiler flag channels case-insensitively", () => {
    expect(
      sanitizedMsvcEnvironment({
        Path: "C:\\tools",
        CL: "/MD",
        cl: "/Od",
        _CL_: "/link /DEFAULTLIB:msvcrt",
        _cl_: "/DOVERRIDE",
        INCLUDE: "C:\\include",
      }),
    ).toEqual({ Path: "C:\\tools", INCLUDE: "C:\\include" });
  });

  it("classifies dependency basenames without depending on dumpbin prose", () => {
    const dependencies = dumpbinDependencyBasenames(`
Microsoft (R) COFF/PE Dumper Version 14

  Abbild hat die folgenden Abhängigkeiten:

    KERNEL32.dll
    USER32.dll
    VCRUNTIME140_1.dll
    api-ms-win-crt-runtime-l1-1-0.dll

  Résumé
`);

    expect(dependencies).toEqual([
      "KERNEL32.dll",
      "USER32.dll",
      "VCRUNTIME140_1.dll",
      "api-ms-win-crt-runtime-l1-1-0.dll",
    ]);
    expect(dynamicCrtDependencies(dependencies)).toEqual([
      "VCRUNTIME140_1.dll",
      "api-ms-win-crt-runtime-l1-1-0.dll",
    ]);
  });

  it("allows ordinary system imports and rejects VC/UCRT runtime families", () => {
    expect(
      dynamicCrtDependencies(["KERNEL32.dll", "USER32.dll", "api-ms-win-core-synch-l1-2-0.dll"]),
    ).toEqual([]);
    expect(
      dynamicCrtDependencies([
        "MSVCP140_ATOMIC_WAIT.dll",
        "msvcrt.dll",
        "ucrtbased.dll",
        "CONCRT140.dll",
        "VCOMP140D.dll",
      ]),
    ).toEqual([
      "MSVCP140_ATOMIC_WAIT.dll",
      "msvcrt.dll",
      "ucrtbased.dll",
      "CONCRT140.dll",
      "VCOMP140D.dll",
    ]);
  });
});
