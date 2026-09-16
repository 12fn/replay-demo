/** JSON-safe application allowance. Usage and reservations always remain numeric. */
export type BudgetLimit = number | 'unlimited';
export type Allowance = 'capped' | 'unlimited';
export interface BudgetUsage {
  /** Optional only for compatibility with earlier saved/client fixture responses. */
  allowance?: Allowance;
  requestsUsed: number;
  maxRequests: BudgetLimit;
  committedUsd: number;
  maxUsd: BudgetLimit;
}
