#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

static void write_all(const char *text) {
	size_t left = strlen(text);
	while (left > 0) {
		ssize_t written = write(STDOUT_FILENO, text, left);
		if (written < 0) {
			if (errno == EINTR) continue;
			_exit(120);
		}
		text += written;
		left -= (size_t)written;
	}
}

static void prompt(void) {
	char cwd[PATH_MAX];
	if (!getcwd(cwd, sizeof(cwd))) _exit(121);
	char line[PATH_MAX + 80];
	if (snprintf(line, sizeof(line), "READY:%s:PID:%ld>", cwd, (long)getpid()) < 0) _exit(122);
	write_all(line);
}

static void scrollback_fixture(void) {
	struct winsize size = { 0 };
	if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &size) != 0 || size.ws_row < 2) _exit(126);
	write_all("\033[3J\033[2J\033[HOUT:scroll-needle\r\n");
	for (unsigned short row = 1; row + 1 < size.ws_row; row++) write_all("\r\n");
	write_all("READY:scroll>");
}

int main(void) {
	struct termios settings;
	if (tcgetattr(STDIN_FILENO, &settings) != 0) return 123;
	cfmakeraw(&settings);
	if (tcsetattr(STDIN_FILENO, TCSANOW, &settings) != 0) return 124;

	char command[512] = { 0 };
	size_t length = 0;
	unsigned char escape[8] = { 0 };
	size_t escape_length = 0;
	prompt();

	for (;;) {
		unsigned char byte;
		ssize_t count = read(STDIN_FILENO, &byte, 1);
		if (count == 0) return 0;
		if (count < 0) {
			if (errno == EINTR) continue;
			return 125;
		}

		if (escape_length == 1) {
			if (byte == '[') {
				escape[escape_length++] = byte;
				continue;
			}
			write_all("<ESC>");
			escape_length = 0;
			goto process_byte;
		}
		if (escape_length == 2) {
			escape[escape_length++] = byte;
			if (escape[1] == '[') {
				switch (byte) {
					case 'A': write_all("<UP>"); break;
					case 'B': write_all("<DOWN>"); break;
					case 'C': write_all("<RIGHT>"); break;
					case 'D': write_all("<LEFT>"); break;
					default: write_all("<ESC>"); break;
				}
			}
			escape_length = 0;
			continue;
		}
	process_byte:
		if (byte == 27) {
			escape[0] = byte;
			escape_length = 1;
			continue;
		}

		if (byte == 3) {
			length = 0;
			command[0] = '\0';
			write_all("^C\r\n");
			prompt();
			continue;
		}
		if (byte == 9) {
			write_all("<TAB>");
			continue;
		}
		if (byte == 127) {
			if (length > 0) {
				command[--length] = '\0';
				write_all("\b \b");
			}
			continue;
		}
		if (byte == '\r' || byte == '\n') {
			write_all("\r\n");
			if (strcmp(command, "exit 7") == 0) return 7;
			if (strcmp(command, "scroll-setup") == 0) {
				scrollback_fixture();
				length = 0;
				command[0] = '\0';
				continue;
			}
			if (strcmp(command, "unicode") == 0) {
				write_all("WIDE:\347\225\214\360\237\231\202\r\n");
				length = 0;
				command[0] = '\0';
				prompt();
				continue;
			}
			write_all("OUT:");
			write_all(command);
			write_all("\r\n");
			length = 0;
			command[0] = '\0';
			prompt();
			continue;
		}
		if (byte >= 32 && byte < 127 && length + 1 < sizeof(command)) {
			command[length++] = (char)byte;
			command[length] = '\0';
			char echoed[2] = { (char)byte, '\0' };
			write_all(echoed);
		}
	}
}
