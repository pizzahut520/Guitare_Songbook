export function createPublishGuard() {
  let active = false;
  let submitted = false;
  return {
    begin(): boolean {
      if (active || submitted) return false;
      active = true;
      return true;
    },
    fail(): void {
      active = false;
    },
    succeed(): void {
      active = false;
      submitted = true;
    },
    get locked(): boolean {
      return active || submitted;
    }
  };
}
