/**
 * Typed contracts for the installed Kamiwaza 1.2 REST API.
 *
 * Every interface below is transcribed from
 * `evidence/platform/installed-openapi.json` (the OpenAPI document served by
 * the installation this app is qualified against). Field names, optionality
 * and enums match that document. Where the platform declares an open object
 * (`additionalProperties: true`) the field is typed as `Record<string, unknown>`
 * rather than guessed at.
 */

// ---------------------------------------------------------------------------
// Auth: POST /auth/token (exempt), GET /auth/users/me
// ---------------------------------------------------------------------------

/** Form body for `POST /auth/token` (`Body_login_auth_token_post`). */
export interface LoginRequest {
  username: string;
  password: string;
  /** OAuth 2.0 grant type. Platform default: `password`. */
  grant_type?: string;
  /** Space-separated scopes. Platform default: `openid email profile offline_access`. */
  scope?: string;
  /** Keycloak client ID. Blank uses the platform default client. */
  client_id?: string | null;
  /** Client secret if the Keycloak client requires one. */
  client_secret?: string | null;
}

/** `TokenResponse`: Keycloak RS256 tokens returned by `POST /auth/token`. */
export interface TokenResponse {
  access_token: string;
  /** Platform default: `bearer`. */
  token_type?: string;
  expires_in: number;
  refresh_token?: string | null;
  id_token?: string | null;
}

/** `UserInfo`: the authenticated user resolved from the bearer token. */
export interface UserInfo {
  username: string;
  email?: string | null;
  groups?: string[];
  roles?: string[];
  sub: string;
}

// ---------------------------------------------------------------------------
// ReBAC: POST /auth/check
// ---------------------------------------------------------------------------

/** Relation literals accepted by `CheckRequest.relation` (regex in the installed schema). */
export const REBAC_RELATIONS = [
  "can_access",
  "cleared_for",
  "connector_operator",
  "editor",
  "executor",
  "includes",
  "invoker",
  "member",
  "mission",
  "mission_member",
  "mission_owner",
  "operator",
  "owner",
  "shared_to_workroom",
  "viewer",
  "writer",
] as const;

export type RebacRelation = (typeof REBAC_RELATIONS)[number];

/** `SubjectModel`. Namespaces seen in the schema examples: `user`, `group`. */
export interface RebacSubject {
  namespace: string;
  id: string;
}

/** `ObjectModel`. Namespaces seen in the schema examples: `model`, `dataset`; evidence also shows `workroom`. */
export interface RebacObject {
  namespace: string;
  id: string;
}

/** `CheckRequest`. */
export interface CheckRequest {
  subject: RebacSubject;
  relation: RebacRelation;
  object: RebacObject;
}

/** `CheckResponse`. */
export interface CheckResponse {
  allow: boolean;
  decision_id: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Workrooms
// ---------------------------------------------------------------------------

/** `WorkroomResponse`: full workroom entity. */
export interface WorkroomResponse {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  name: string;
  type: string;
  description?: string | null;
  labels?: string[] | null;
  classification?: string | null;
  attributes?: Record<string, unknown> | null;
  scg_references?: string[] | null;
  status: string;
  created_at: string;
  updated_at?: string | null;
  deleted_at?: string | null;
  member_count?: number;
  membership_role?: string | null;
  is_owner?: boolean;
  is_shared?: boolean;
  owner_username?: string | null;
  owner_email?: string | null;
}

/** `WorkroomShellAccessState`. */
export type WorkroomShellAccessState = "active" | "read_only" | "archived" | "unbound";

/** `WorkroomRuntimeContextResponse`: authoritative runtime context for the shell. */
export interface WorkroomRuntimeContextResponse {
  workroom_id: string;
  user_id: string;
  effective_workroom_role: string;
  workroom_lifecycle_state: string;
  interaction_mode: string;
  access_state: WorkroomShellAccessState;
  can_edit?: boolean;
  can_share?: boolean;
  can_run_agents?: boolean;
  read_only_reason?: string | null;
  status_banner?: string | null;
}

/** `EnterWorkroomResponse`: session binding result. Token fields are Lite/SAML mode only. */
export interface EnterWorkroomResponse {
  workroom_id: string;
  access_token?: string | null;
  expires_in?: number | null;
  message?: string;
}

/** `LeaveWorkroomResponse`. */
export interface LeaveWorkroomResponse {
  workroom_id: string;
  access_token?: string | null;
  expires_in?: number | null;
  message?: string;
}

// ---------------------------------------------------------------------------
// Extensions: GET/POST /extensions
// ---------------------------------------------------------------------------

/** `ExtensionServiceStatus`. */
export interface ExtensionServiceStatus {
  name: string;
  ready?: boolean;
  replicas?: number;
  available_replicas?: number;
  message?: string | null;
  image_tag?: string | null;
  image_digest?: string | null;
}

/** `ExtensionEndpoints`. */
export interface ExtensionEndpoints {
  external?: string | null;
  internal?: string | null;
  runtime_path?: string | null;
}

/** `Extension`: response mapped from the KamiwazaExtension CR. */
export interface Extension {
  /** Concrete runtime CR name. Persist this for follow-up calls. */
  name: string;
  template_name?: string | null;
  type: string;
  version: string;
  phase?: string | null;
  services?: ExtensionServiceStatus[];
  endpoints?: ExtensionEndpoints | null;
  owner_user_id?: string | null;
  workroom_id?: string | null;
  created_at?: string | null;
}

/** `ExtensionPort`. */
export interface ExtensionPort {
  name?: string | null;
  container_port: number;
  protocol?: "TCP" | "UDP";
}

/** `ResourceSpec`. */
export interface ResourceSpec {
  requests?: Record<string, string> | null;
  limits?: Record<string, string> | null;
}

/** `ExtensionServiceSpec`. */
export interface ExtensionServiceSpec {
  name: string;
  image: string;
  primary?: boolean;
  ports?: ExtensionPort[];
  env?: Record<string, unknown>[] | null;
  replicas?: number;
  resources?: ResourceSpec | null;
  command?: string[] | null;
  args?: string[] | null;
  automountServiceAccountToken?: boolean | null;
  containerSecurityContext?: Record<string, unknown> | null;
  healthCheck?: Record<string, unknown> | null;
  persistence?: Record<string, unknown> | null;
  volumes?: Record<string, unknown>[] | null;
  volumeMounts?: Record<string, unknown>[] | null;
}

/** `KamiwazaIntegrationSpec`. */
export interface KamiwazaIntegrationSpec {
  namespace?: string;
  api_url?: string | null;
  public_api_url?: string | null;
  origin?: string | null;
  /** Platform default: `"true"` (string, as declared). */
  use_auth?: string;
}

/** `NetworkPolicySpec`. */
export interface NetworkPolicySpec {
  enabled?: boolean;
  allow_namespaces?: string[] | null;
  allow_external_access?: boolean | null;
}

/** `NetworkingSpec`. */
export interface NetworkingSpec {
  ingress_enabled?: boolean;
  path_prefix?: string | null;
  network_policy?: NetworkPolicySpec | null;
}

/** `SandboxSpec`. */
export interface SandboxSpec {
  enabled?: boolean;
  namespace?: string | null;
  service_name?: string | null;
  persistence?: boolean;
  resources?: ResourceSpec | null;
  image_whitelist?: string[];
  max_lifetime_seconds?: number | null;
}

/** `SecuritySpec`. */
export interface SecuritySpec {
  /** 0=guided, 1=scanned, 2=break_glass. */
  risk_tier?: 0 | 1 | 2;
  source_type?: string;
  verified?: boolean;
}

/** `CreateExtension`: request body for `POST /extensions`. */
export interface CreateExtension {
  /** K8s DNS label. */
  name: string;
  type: "app" | "tool" | "service" | "connector";
  version: string;
  services: ExtensionServiceSpec[];
  kamiwaza?: KamiwazaIntegrationSpec | null;
  networking?: NetworkingSpec | null;
  sandbox?: SandboxSpec | null;
  security?: SecuritySpec | null;
  workroom_id?: string | null;
  /** Only `kamiwaza.ai/*` keys are accepted by the platform. */
  annotations?: Record<string, string> | null;
  workload_identity?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Context / ontology: /context/ontologies/**
// ---------------------------------------------------------------------------

export type OntologyBackend = "graphiti" | "graphrag" | "openspg" | "kag";
export type OntologyStatus = "pending" | "running" | "stopped" | "failed";
export type OntologyIngestionStatus = "none" | "queued" | "running" | "failed" | "done";

/** `OntologyInstance`. */
export interface OntologyInstance {
  id: string;
  name: string;
  backend: OntologyBackend;
  status: OntologyStatus;
  status_reason?: string | null;
  status_details?: Record<string, unknown> | null;
  ingestion_status?: OntologyIngestionStatus;
  ingestion_error?: string | null;
  ingestion_updated_at?: string | null;
  endpoint?: string | null;
  workroom_id?: string | null;
  created_at: string;
  updated_at?: string | null;
}

/** `MessageInput`: one message to add to the knowledge graph. */
export interface MessageInput {
  content: string;
  /** Platform default: `user`. */
  role?: string;
  role_type?: string | null;
  name?: string | null;
  timestamp?: string | null;
  source_description?: string | null;
}

/** `EntityTypeSchema`. */
export interface EntityTypeSchema {
  description: string;
  fields?: Record<string, string> | null;
}

/** `AddKnowledgeRequest`. */
export interface AddKnowledgeRequest {
  group_id: string;
  messages: MessageInput[];
  entity_types?: Record<string, EntityTypeSchema> | null;
  excluded_entity_types?: string[] | null;
}

/** `AddKnowledgeResult`. */
export interface AddKnowledgeResult {
  added_count: number;
  group_id: string;
  /** Backend-specific result data. */
  result?: Record<string, unknown> | null;
  error?: string | null;
}

/** `SearchKnowledgeRequest`. */
export interface SearchKnowledgeRequest {
  query: string;
  group_ids: string[];
  /** 1..100, platform default 10. */
  max_results?: number;
}

/** `Fact`. */
export interface Fact {
  /** Join key against `KnowledgeSearchResult.sources[].fact_uuid` when present. */
  fact_uuid?: string | null;
  content: string;
  score?: number | null;
  source?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** `SourceRef`. */
export interface SourceRef {
  source_id: string;
  chunk_id?: string | null;
  source_urn?: string | null;
  score?: number | null;
}

/** `FactSourceAttribution`. */
export interface FactSourceAttribution {
  fact_uuid: string;
  sources?: SourceRef[];
}

/** `KnowledgeSearchResult`. */
export interface KnowledgeSearchResult {
  facts?: Fact[];
  query: string;
  total_count: number;
  sources?: FactSourceAttribution[];
}

/** `Episode`. */
export interface Episode {
  episode_id?: string | null;
  content: string;
  source: string;
  timestamp?: string | null;
  group_id: string;
  metadata?: Record<string, unknown> | null;
}

/** `EpisodesResult`. */
export interface EpisodesResult {
  episodes?: Episode[];
  group_id: string;
  count: number;
}

/** `GET /context/ontologies/{id}/health` is declared as an open object. */
export type OntologyHealth = Record<string, unknown>;

/** `GET /context/health` has no declared schema. */
export type ContextHealth = unknown;

/** `HTTPValidationError` (422). */
export interface HttpValidationError {
  detail?: ValidationError[];
}

/** `ValidationError`. */
export interface ValidationError {
  loc: (string | number)[];
  msg: string;
  type: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
}
