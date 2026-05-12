const PREFIX = "[project-manager:profile]";

export function getProfileStart() {
  return Date.now();
}

export function getProfileDuration(start: number) {
  return Date.now() - start;
}

export function logProfile(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.log(PREFIX, message, details);
  } else {
    console.log(PREFIX, message);
  }
}
