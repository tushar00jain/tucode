#pragma once
#include <stdint.h>
void *tucode_app_start(void);
void tucode_app_stop(void *app, void (*finished)(void));
uint64_t tucode_editor_create(const void *app, void *parent, void *configuration);
void *tucode_editor_view(uint64_t editor);
void tucode_editor_close(uint64_t editor);
const char *tucode_editor_error(void);
