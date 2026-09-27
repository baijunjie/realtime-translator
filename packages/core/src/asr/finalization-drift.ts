/** One live-to-final comparison produced by FinalizationDriftTracker. */
export interface FinalizationPair {
  partial: string;
  final: string;
}

/**
 * Tracks the longest live text for each finalized line without confusing a long-line force split
 * with a destructive final rewrite. Pipeline callbacks do not label force splits, so settlement is
 * delayed until the next partial: an empty partial closes a natural segment; a non-empty partial
 * means the line continued across a committed boundary. A clear without a preceding segment records
 * a dropped line as `partial -> ''` instead of silently reporting zero drift.
 */
export class FinalizationDriftTracker {
  readonly pairs: FinalizationPair[] = [];
  private bestPartial = '';
  private pendingFinal: string | null = null;

  constructor(private readonly normalize: (text: string) => string) {}

  reset(): void {
    this.pairs.length = 0;
    this.bestPartial = '';
    this.pendingFinal = null;
  }

  onSegment(text: string): void {
    if (this.pendingFinal !== null) this.settlePending(true);
    this.pendingFinal = text;
  }

  onPartial(text: string): void {
    if (this.pendingFinal !== null) this.settlePending(text !== '');
    if (text === '') {
      if (this.bestPartial) {
        this.pairs.push({ partial: this.bestPartial, final: '' });
        this.bestPartial = '';
      }
      return;
    }
    if (this.length(text) > this.length(this.bestPartial)) this.bestPartial = text;
  }

  /** Settle callbacks left pending when an input stream ends without another partial event. */
  finish(): void {
    if (this.pendingFinal !== null) this.settlePending(false);
    if (this.bestPartial) {
      this.pairs.push({ partial: this.bestPartial, final: '' });
      this.bestPartial = '';
    }
  }

  private settlePending(continued: boolean): void {
    const final = this.pendingFinal ?? '';
    let partial = this.bestPartial;
    let carry = '';
    if (continued && partial.startsWith(final)) {
      // The live line included both the committed prefix and the next line's tail. Attribute only
      // the prefix to this final and retain the tail so a later segment can still be measured.
      carry = partial.slice(final.length);
      partial = final;
    }
    this.pairs.push({ partial, final });
    this.bestPartial = carry;
    this.pendingFinal = null;
  }

  private length(text: string): number {
    return Array.from(this.normalize(text)).length;
  }
}
