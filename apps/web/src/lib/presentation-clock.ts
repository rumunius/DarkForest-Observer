/** Advances presentation time inside a selected scene; does not settle match phases. */
export class PresentationClock {
  private base = 1942;
  private startedAt: number;
  private frozen = false;
  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = now();
  }
  get seconds(): number {
    const current =
      this.base + (this.frozen ? 0 : Math.floor((this.now() - this.startedAt) / 1000));
    const ceiling =
      this.base < 3900 ? 3899 : this.base < 5400 ? 5399 : this.base < 5880 ? 5879 : 7199;
    return Math.min(current, ceiling);
  }
  reset(seconds: number, frozen = false): void {
    this.base = seconds;
    this.startedAt = this.now();
    this.frozen = frozen;
  }
  setPaused(paused: boolean): void {
    if (paused === this.frozen) return;
    this.base = this.seconds;
    this.startedAt = this.now();
    this.frozen = paused;
  }
}
