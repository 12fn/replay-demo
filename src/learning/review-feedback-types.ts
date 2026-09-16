export type ReviewFeedbackSection =
  | 'headline'
  | 'observations'
  | 'opponentPerspective'
  | 'tradeoffs'
  | 'questions'
  | 'nextPractice'
  | 'limitations';

export type ReviewFeedbackDisposition = 'accepted' | 'edited' | 'rejected';

export interface ReviewFeedbackCriterion {
  id: string;
  name: string;
  objective: string;
}

/** One immutable instructor revision of one claim in an actual generated debrief. */
export interface ReviewFeedback {
  schema: 'replay.review-feedback/1';
  id: string;
  exerciseId: string;
  eventId: string;
  hash: string;
  section: ReviewFeedbackSection;
  index: number;
  disposition: ReviewFeedbackDisposition;
  criterionId: string;
  criterionName: string;
  criterionObjective: string;
  explanation: string;
  editedText?: string;
  nextPractice: string;
  author: string;
  recordedAt: string;
  previousId?: string;
  originalText: string;
  originalCitations: string[];
}

export interface ReviewFeedbackResponse {
  exerciseId: string;
  eventId: string;
  hash: string;
  /** Chronological revision history; the latest review is the final entry. */
  reviews: ReviewFeedback[];
  criteria: ReviewFeedbackCriterion[];
  canReview: boolean;
  truncated: boolean;
}
