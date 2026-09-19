#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/input-event-codes.h>
#include <linux/uinput.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

static volatile sig_atomic_t keep_running = 1;

static void handle_signal(int sig) {
  (void)sig;
  keep_running = 0;
}

static int emit_event(int fd, uint16_t type, uint16_t code, int32_t value) {
  struct input_event event;
  memset(&event, 0, sizeof(event));
  event.type = type;
  event.code = code;
  event.value = value;
  return write(fd, &event, sizeof(event)) == (ssize_t)sizeof(event) ? 0 : -1;
}

static int emit_key(int fd, unsigned int code, int value) {
  if (emit_event(fd, EV_KEY, (uint16_t)code, value) < 0) return -1;
  return emit_event(fd, EV_SYN, SYN_REPORT, 0);
}

static int create_virtual_keyboard(void) {
  int fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
  if (fd < 0) {
    fprintf(stderr, "KEYBRIDGE_ERROR cannot open /dev/uinput: %s\n", strerror(errno));
    return -1;
  }

  if (ioctl(fd, UI_SET_EVBIT, EV_KEY) < 0 || ioctl(fd, UI_SET_EVBIT, EV_REP) < 0) {
    fprintf(stderr, "KEYBRIDGE_ERROR failed to enable keyboard events: %s\n", strerror(errno));
    close(fd);
    return -1;
  }

  for (int code = 0; code <= KEY_MAX; code++) {
    if (ioctl(fd, UI_SET_KEYBIT, code) < 0) {
      fprintf(stderr, "KEYBRIDGE_ERROR failed to enable key %d: %s\n", code, strerror(errno));
      close(fd);
      return -1;
    }
  }

  struct uinput_setup setup;
  memset(&setup, 0, sizeof(setup));
  setup.id.bustype = BUS_USB;
  setup.id.vendor = 0x4b42;   // "KB"
  setup.id.product = 0x0001;
  setup.id.version = 1;
  snprintf(setup.name, UINPUT_MAX_NAME_SIZE, "KeyBridge Virtual Keyboard");

  if (ioctl(fd, UI_DEV_SETUP, &setup) < 0) {
    fprintf(stderr, "KEYBRIDGE_ERROR UI_DEV_SETUP failed: %s\n", strerror(errno));
    close(fd);
    return -1;
  }

  if (ioctl(fd, UI_DEV_CREATE) < 0) {
    fprintf(stderr, "KEYBRIDGE_ERROR UI_DEV_CREATE failed: %s\n", strerror(errno));
    close(fd);
    return -1;
  }

  return fd;
}

int main(void) {
  signal(SIGINT, handle_signal);
  signal(SIGTERM, handle_signal);
  setvbuf(stdout, NULL, _IOLBF, 0);
  setvbuf(stderr, NULL, _IOLBF, 0);

  int fd = create_virtual_keyboard();
  if (fd < 0) return 2;

  // Give udev/libinput a short moment to register the virtual device.
  usleep(200000);
  puts("KEYBRIDGE_READY");

  char line[128];
  while (keep_running && fgets(line, sizeof(line), stdin) != NULL) {
    unsigned int code = 0;
    int value = -1;

    if (sscanf(line, "%u %d", &code, &value) != 2) {
      fprintf(stderr, "KEYBRIDGE_WARN ignored malformed input command\n");
      continue;
    }

    if (code > KEY_MAX || (value != 0 && value != 1)) {
      fprintf(stderr, "KEYBRIDGE_WARN ignored invalid key command code=%u value=%d\n", code, value);
      continue;
    }

    if (emit_key(fd, code, value) < 0) {
      fprintf(stderr, "KEYBRIDGE_ERROR failed to emit key code=%u: %s\n", code, strerror(errno));
      ioctl(fd, UI_DEV_DESTROY);
      close(fd);
      return 3;
    }
  }

  ioctl(fd, UI_DEV_DESTROY);
  close(fd);
  return 0;
}
