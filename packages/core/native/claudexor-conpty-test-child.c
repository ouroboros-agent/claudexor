#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

static int write_all(HANDLE destination, const char *bytes, DWORD length) {
  while (length > 0) {
    DWORD written = 0;
    if (!WriteFile(destination, bytes, length, &written, NULL) || written == 0)
      return 0;
    bytes += written;
    length -= written;
  }
  return 1;
}

static void print_decoded_argv(void) {
  int decoded_argc = 0;
  wchar_t **decoded = CommandLineToArgvW(GetCommandLineW(), &decoded_argc);
  if (decoded == NULL) ExitProcess(70);
  for (int index = 0; index < decoded_argc; index += 1) {
    size_t length = wcslen(decoded[index]);
    printf("ARG\t%d\t%zu\t", index, length);
    for (size_t unit = 0; unit < length; unit += 1)
      printf("%04X", (unsigned)decoded[index][unit]);
    printf("\n");
  }
  fflush(stdout);
  LocalFree(decoded);
}

static int parse_exit(const wchar_t *value) {
  wchar_t *end = NULL;
  long parsed = wcstol(value, &end, 10);
  if (end == value || *end != L'\0' || parsed < 0 || parsed > 255) return 2;
  return (int)parsed;
}

static int run_interactive(void) {
  const char first[] = "Sign in at https://accounts.google.com/o/oauth2/";
  const char second[] = "auth?state=claudexor-conpty-fixture\r\n";
  fwrite(first, 1, sizeof(first) - 1, stdout);
  fflush(stdout);
  Sleep(40);
  fwrite(second, 1, sizeof(second) - 1, stdout);
  fflush(stdout);

  char code[512];
  if (fgets(code, sizeof(code), stdin) == NULL) return 3;
  size_t length = strlen(code);
  while (length > 0 && (code[length - 1] == '\r' || code[length - 1] == '\n'))
    code[--length] = '\0';
  printf("\x1b[31mCODE:%s\x1b[0m\r\n", code);
  fflush(stdout);
  return 0;
}

static int conin_available(void) {
  HANDLE input = CreateFileW(L"CONIN$", GENERIC_READ | GENERIC_WRITE,
                             FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                             OPEN_EXISTING, 0, NULL);
  if (input == INVALID_HANDLE_VALUE) return 0;
  CloseHandle(input);
  return 1;
}

static void print_console_state(HANDLE destination, const char *label) {
  HWND window = GetConsoleWindow();
  char line[96];
  int length = snprintf(line, sizeof(line), "%s\t%u\t%d\t%d\t%d\n", label,
                        (unsigned)GetConsoleCP(), window != NULL ? 1 : 0,
                        window != NULL && IsWindowVisible(window) ? 1 : 0,
                        conin_available());
  if (length > 0 && (size_t)length < sizeof(line))
    (void)write_all(destination, line, (DWORD)length);
}

static int console_control(void) {
  HANDLE captured_output = GetStdHandle(STD_OUTPUT_HANDLE);
  BOOL allocated = AllocConsole();
  print_console_state(captured_output, "CONTROL");
  int available = GetConsoleCP() != 0 && conin_available();
  if (allocated) (void)FreeConsole();
  return available ? 0 : 74;
}

static BOOL WINAPI stall_close_handler(DWORD control_type) {
  if (control_type != CTRL_CLOSE_EVENT) return FALSE;
  Sleep(INFINITE);
  return TRUE;
}

static int spawn_descendant(const wchar_t *self, BOOL stream_output,
                            BOOL stall_close) {
  if (stall_close && !SetConsoleCtrlHandler(stall_close_handler, TRUE)) return 75;
  size_t length = wcslen(self) + 32;
  wchar_t *command = (wchar_t *)calloc(length, sizeof(wchar_t));
  if (command == NULL) return 71;
  if (swprintf_s(command, length, L"\"%ls\" --wait", self) < 0) {
    free(command);
    return 72;
  }
  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  startup.cb = sizeof(startup);
  if (!CreateProcessW(self, command, NULL, NULL, FALSE, 0, NULL, NULL, &startup,
                      &process)) {
    free(command);
    return 73;
  }
  free(command);
  CloseHandle(process.hThread);
  printf("PIDS\t%lu\t%lu\n", (unsigned long)GetCurrentProcessId(),
         (unsigned long)process.dwProcessId);
  fflush(stdout);
  if (stream_output) {
    for (;;) {
      fputs("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
            stdout);
      fflush(stdout);
      Sleep(1);
    }
  }
  (void)WaitForSingleObject(process.hProcess, INFINITE);
  CloseHandle(process.hProcess);
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc >= 2 && wcscmp(argv[1], L"--argv") == 0) {
    print_decoded_argv();
    return 0;
  }
  if (argc == 2 && wcscmp(argv[1], L"--interactive") == 0)
    return run_interactive();
  if (argc == 3 && wcscmp(argv[1], L"--exit") == 0)
    return parse_exit(argv[2]);
  if (argc == 2 && wcscmp(argv[1], L"--slow-drain") == 0) {
    for (int block = 0; block < 1024; block += 1) {
      fputs("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
            stdout);
    }
    fflush(stdout);
    return 0;
  }
  if (argc == 2 && wcscmp(argv[1], L"--console-state") == 0) {
    print_console_state(GetStdHandle(STD_OUTPUT_HANDLE), "CONSOLE");
    return 0;
  }
  if (argc == 2 && wcscmp(argv[1], L"--console-control") == 0)
    return console_control();
  if (argc == 2 && wcscmp(argv[1], L"--spawn-descendant") == 0)
    return spawn_descendant(argv[0], FALSE, FALSE);
  if (argc == 2 && wcscmp(argv[1], L"--stream-descendant") == 0)
    return spawn_descendant(argv[0], TRUE, FALSE);
  if (argc == 2 && wcscmp(argv[1], L"--ignore-close-stream-descendant") == 0)
    return spawn_descendant(argv[0], TRUE, TRUE);
  if (argc == 2 && wcscmp(argv[1], L"--wait") == 0) {
    for (;;) Sleep(1000);
  }
  return 2;
}
