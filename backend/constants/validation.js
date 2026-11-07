/**
 * Field rules shared by the User model and the request validators.
 * Keeping them in one place means the API rejects a value for the same reason
 * the database would, and the two can never drift apart.
 */

export const USER_FIELD_LIMITS = Object.freeze({
  NAME_MIN_LENGTH: 1,
  NAME_MAX_LENGTH: 100,
  // Maximum length of an email address per RFC 5321 (forward-path limit).
  EMAIL_MAX_LENGTH: 254,
  PASSWORD_MIN_LENGTH: 8,
  // bcrypt only uses the first 72 bytes of its input; anything longer would be silently
  // ignored, so a longer password would give a false sense of strength. Measured in UTF-8
  // bytes, not characters, because multi-byte characters count more than once.
  PASSWORD_MAX_BYTES: 72,
  // First and last name at signup; together (with a space) they stay within NAME_MAX_LENGTH.
  GIVEN_NAME_MAX_LENGTH: 50,
  FAMILY_NAME_MAX_LENGTH: 49,
});

/**
 * Phone numbers are stored in international (E.164) form: "+", the country code, then the number,
 * 8 to 15 digits in all. A number typed without a country code is read as a national number of
 * the country picked beside it, DEFAULT_COUNTRY when none is (utils/phoneNumbers.js).
 */
export const PHONE_SETTINGS = Object.freeze({
  // ISO 3166-1 alpha-2: the country the sign-up screen's picker starts on.
  DEFAULT_COUNTRY: 'IN',
  E164_PATTERN: /^\+[1-9]\d{7,14}$/,
  // What a person may type: digits, spaces, dashes, dots, brackets and a leading + or 00.
  MAX_INPUT_LENGTH: 25,
});

/**
 * The version of the terms of service and privacy policy a signup agrees to. Raise it when they
 * change; each account keeps the version it accepted (User.termsVersion).
 */
export const TERMS_VERSION = 1;

/** What a person may give as their gender at signup (labels: constants/messages.js GENDER_LABELS). */
export const GENDERS = Object.freeze({
  MALE: 'male',
  FEMALE: 'female',
  NON_BINARY: 'non_binary',
  PREFER_NOT_TO_SAY: 'prefer_not_to_say',
});

/**
 * Date of birth and gender at signup.
 *
 *   BIRTH_DATE_AND_GENDER_REQUIRED  whether a signup must give both (the sign-up screen asks for
 *                                   them). Either way, they are checked and stored when sent.
 *   MINIMUM_AGE_YEARS               the youngest a person may be to create an account
 *   MAXIMUM_AGE_YEARS               older than this is taken for a typing mistake
 *   BIRTH_DATE_PATTERN              how the date is sent: YYYY-MM-DD (what a date input gives)
 */
export const SIGNUP_PROFILE_SETTINGS = Object.freeze({
  BIRTH_DATE_AND_GENDER_REQUIRED: true,
  MINIMUM_AGE_YEARS: 18,
  MAXIMUM_AGE_YEARS: 120,
  BIRTH_DATE_PATTERN: /^\d{4}-\d{2}-\d{2}$/,
});

/**
 * Links emailed to account owners (services/accountEmailFlows.js):
 *   EMAIL_VERIFICATION_VALIDITY_MS   how long a "confirm your email" link works
 *   PASSWORD_RESET_VALIDITY_MS       how long a "reset your password" link works; short, because it
 *                                    grants control of an existing account
 *   EMAIL_COOLDOWN_MS                the least time between two such emails to one address, whether
 *                                    or not it has an account (an inbox cannot be flooded, and the
 *                                    wait does not reveal which addresses are registered)
 */
export const ACCOUNT_EMAIL_SETTINGS = Object.freeze({
  EMAIL_VERIFICATION_VALIDITY_MS: 24 * 60 * 60 * 1000,
  PASSWORD_RESET_VALIDITY_MS: 15 * 60 * 1000,
  EMAIL_COOLDOWN_MS: 60 * 1000,
  // The confirmation email also carries a code to type instead of opening the link. Wrong codes
  // are counted per email: after the last allowed try, the code and its link stop working.
  VERIFICATION_CODE_DIGITS: 6,
  VERIFICATION_CODE_MAX_ATTEMPTS: 5,
});

/**
 * Frontend pages that account emails link to. The two token links are `${APP_PUBLIC_URL}${path}/<token>`;
 * the others are plain pages.
 */
export const ACCOUNT_LINK_PATHS = Object.freeze({
  EMAIL_VERIFICATION: '/verify-email',
  PASSWORD_RESET: '/reset-password',
  SIGN_IN: '/login',
  FORGOT_PASSWORD: '/forgot-password',
});

/**
 * Password strength rules applied at signup, in addition to the length limits above.
 * Each pattern must match at least once somewhere in the password. Messages for each
 * `ruleId` live in constants/messages.js (PASSWORD_RULE_MESSAGES).
 *
 * The frontend (frontend/src/constants/validation.js) enforces the same rules with the same
 * patterns for instant feedback. This backend copy is the one that actually protects the
 * system: the API rejects a weak password no matter which client sent it.
 */
export const PASSWORD_STRENGTH_RULES = Object.freeze([
  // [A-Z]: at least one ASCII uppercase letter.
  { ruleId: 'uppercaseLetter', pattern: /[A-Z]/ },
  // [a-z]: at least one ASCII lowercase letter.
  { ruleId: 'lowercaseLetter', pattern: /[a-z]/ },
  // \d: at least one digit 0–9.
  { ruleId: 'digit', pattern: /\d/ },
  // [^A-Za-z0-9\s]: at least one character that is not a letter, digit, or whitespace
  // (punctuation or a symbol). Spaces are allowed in passwords but do not satisfy this rule.
  { ruleId: 'specialCharacter', pattern: /[^A-Za-z0-9\s]/ },
]);

/**
 * The strength meter: how many checklist items (the minimum length plus each strength rule, five in
 * all) a password meets decides its level. Only "strong" (all of them) is accepted at signup and
 * reset; the lower levels guide the person while typing. Labels: PASSWORD_STRENGTH_LABELS.
 */
export const PASSWORD_STRENGTH_LEVELS = Object.freeze([
  Object.freeze({ level: 'weak', minimumChecksMet: 0 }),
  Object.freeze({ level: 'fair', minimumChecksMet: 3 }),
  Object.freeze({ level: 'good', minimumChecksMet: 4 }),
  Object.freeze({ level: 'strong', minimumChecksMet: 5 }),
]);

/** Limits for conversation messages, shared by the Message model and the webhook validator. */
export const MESSAGE_FIELD_LIMITS = Object.freeze({
  // Large enough for a long AI answer; keeps a message far below MongoDB's 16 MB document limit.
  TEXT_MAX_LENGTH: 20_000,
});

/** Limits for inbound webhook payloads. */
export const WEBHOOK_FIELD_LIMITS = Object.freeze({
  // The sender's unique id for this message, used for de-duplication. Provider ids are typically
  // UUIDs or similar; 200 characters leaves room for prefixed formats.
  EVENT_ID_MAX_LENGTH: 200,
  // Signatures older or newer than this are rejected, which bounds how long a captured request
  // could be replayed (replays inside the window are caught by eventId de-duplication).
  SIGNATURE_TOLERANCE_SECONDS: 300,
});

/** Printable ASCII without whitespace: what an eventId may contain. */
export const WEBHOOK_EVENT_ID_PATTERN = /^[\x21-\x7E]+$/;

/**
 * Pragmatic email shape check: one "@", no whitespace, and a dot in the domain.
 * Full RFC 5322 validation is not attempted; deliverability is proven only by sending mail.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Limits for the HR models (Department, EmployeeProfile), shared with their request validators. */
export const ORGANIZATION_FIELD_LIMITS = Object.freeze({
  DEPARTMENT_NAME_MAX_LENGTH: 120,
  DEPARTMENT_SLUG_MAX_LENGTH: 60,
  // Short code (up to 6) plus up to 8 digits, with room for numbers past the padding.
  EMPLOYEE_CODE_MAX_LENGTH: 20,
  DESIGNATION_MAX_LENGTH: 120,
  // Deepest reporting chain or department tree walked by the cycle check. Real organisations are
  // far shallower (a 100,000-person company is rarely more than 12 levels deep); the cap bounds
  // the cost of the check and of $graphLookup traversals.
  HIERARCHY_MAX_DEPTH: 50,
  // Geofence radius in metres. Below ~25 m, ordinary phone GPS error (5–20 m outdoors, worse
  // indoors) would reject employees standing inside the office; above 10 km it stops being a
  // meaningful site check.
  GEOFENCE_RADIUS_MIN_METRES: 25,
  GEOFENCE_RADIUS_MAX_METRES: 10_000,
  SCORE_MIN: 0,
  SCORE_MAX: 100,
});

/** Limits for the employee document vault (models/DocumentVault.js, controllers/vaultController.js). */
export const VAULT_FIELD_LIMITS = Object.freeze({
  // Largest accepted upload. Files are buffered in memory before going to S3, so this also bounds
  // the memory one upload can hold.
  MAX_FILE_BYTES: 10 * 1024 * 1024,
  ORIGINAL_FILE_NAME_MAX_LENGTH: 255,
  // Lifetime of a pre-signed download URL.
  DOWNLOAD_URL_TTL_SECONDS: 60,
  // Most documents returned by one listing call.
  LIST_LIMIT: 100,
});

/** Limits for attendance punches (models/Attendance.js, controllers/attendanceController.js). */
export const ATTENDANCE_FIELD_LIMITS = Object.freeze({
  // A browser Geolocation reading less precise than this cannot place someone inside a typical
  // office geofence, so the punch is refused and the user asked to retry (usually with GPS on).
  MAX_LOCATION_ACCURACY_METRES: 100,
  // The least precise reading kept at all. Laptops at home often only know their place from Wi-Fi
  // (a kilometre or more), which is fine where no office radius is checked; beyond this it is not a
  // location at all.
  MAX_REPORTED_ACCURACY_METRES: 100_000,
  DEVICE_FINGERPRINT_MIN_LENGTH: 16,
  DEVICE_FINGERPRINT_MAX_LENGTH: 256,
  OFFICE_NAME_MAX_LENGTH: 120,
  // Shift policy bounds, in minutes.
  LATE_GRACE_MAX_MINUTES: 180,
  HALF_DAY_AFTER_MAX_MINUTES: 720,
  // How many days back the regularization agent may regularize on its own. Must equal
  // MAX_REGULARIZATION_AGE_DAYS in ai-service app/nodes/attendance_agent.py; the backend enforces it
  // regardless of what the agent sends.
  SELF_SERVICE_REGULARIZATION_DAYS: 7,
  // How many days back a manager may approve a reviewed regularization.
  MANAGER_REGULARIZATION_DAYS: 31,
  // Longest employee message forwarded to the regularization agent (matches the ai-service schema).
  REGULARIZATION_MESSAGE_MAX_LENGTH: 2000,
  REVIEW_NOTE_MAX_LENGTH: 500,
  // How long after the shift ends a forgotten punch-out is closed automatically, at most.
  AUTO_PUNCH_OUT_AFTER_MAX_MINUTES: 720,
  // Why someone punched in "on duty" (a client site, travel): enough for "Client visit, Infosys Pune".
  ON_DUTY_REASON_MIN_LENGTH: 3,
  ON_DUTY_REASON_MAX_LENGTH: 300,
});

/**
 * Attendance settings a new office starts with (models/OfficeLocation.js); HR changes them per office.
 *   OFFICE_GEOFENCE_RADIUS_METRES  how far from the office an office punch-in is accepted. 200 m covers
 *                                  a large building and its car park with ordinary phone GPS error.
 *   AUTO_PUNCH_OUT_AFTER_MINUTES   a punch-in still open this long after the shift ends is closed
 *                                  at the shift end, marked as closed automatically.
 */
export const ATTENDANCE_DEFAULTS = Object.freeze({
  OFFICE_GEOFENCE_RADIUS_METRES: 200,
  AUTO_PUNCH_OUT_AFTER_MINUTES: 120,
});

/**
 * Presence (services/presence.js): who is available, away or offline, set automatically from
 * activity in the app. Each company's own values are in its settings (models/CompanySettings.js).
 *   AWAY_AFTER_MINUTES       no keyboard or mouse use for this long (or a locked screen) shows Away
 *   DETAIL_RETENTION_DAYS    how long each available/away period is kept
 *   SUMMARY_RETENTION_DAYS   how long the daily totals are kept
 */
export const PRESENCE_DEFAULTS = Object.freeze({
  AWAY_AFTER_MINUTES: 5,
  DETAIL_RETENTION_DAYS: 90,
  SUMMARY_RETENTION_DAYS: 730,
});

export const PRESENCE_LIMITS = Object.freeze({
  AWAY_AFTER_MIN_MINUTES: 1,
  AWAY_AFTER_MAX_MINUTES: 60,
  DETAIL_RETENTION_MIN_DAYS: 7,
  DETAIL_RETENTION_MAX_DAYS: 365,
  SUMMARY_RETENTION_MIN_DAYS: 30,
  SUMMARY_RETENTION_MAX_DAYS: 3650,
});

/**
 * The version of the presence notice people acknowledge before their activity is recorded. Raise it
 * when the notice (frontend constants/presence.js) changes what it says, so everyone sees it again.
 */
export const PRESENCE_NOTICE_VERSION = 1;

/** "HH:MM" on a 24-hour clock, 00:00–23:59. */
export const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Calendar date "YYYY-MM-DD" (shape only; real-date validity is checked separately). */
export const CALENDAR_DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** Calendar month "YYYY-MM" (accrual periods, payroll months). */
export const CALENDAR_MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/**
 * Workforce risk bands for the 0-100 model scores (attritionRiskIndex, currentBurnoutScore).
 *   safe       score < ELEVATED_FROM
 *   elevated   ELEVATED_FROM ≤ score < CRITICAL_FROM   (monitor; a manager check-in is advised)
 *   critical   score ≥ CRITICAL_FROM                    (action required)
 * A policy choice, kept here so every consumer classifies identically.
 */
export const WORKFORCE_RISK_BANDS = Object.freeze({
  ELEVATED_FROM: 40,
  CRITICAL_FROM: 70,
});

/**
 * Limits for leave (models/LeaveType.js, models/LeaveLedgerEntry.js, services/leave*). Day amounts
 * are stored as whole hundredths of a day ("centidays"), so sums never drift.
 */
export const LEAVE_LIMITS = Object.freeze({
  CENTIDAYS_PER_DAY: 100,
  // Leave type codes: CL, SL, EL, LOP, MATERNITY...
  TYPE_CODE_PATTERN: /^[A-Z][A-Z0-9_]{1,19}$/,
  TYPE_NAME_MIN_LENGTH: 2,
  TYPE_NAME_MAX_LENGTH: 60,
  TYPE_DESCRIPTION_MAX_LENGTH: 500,
  // Policy day values (quotas, caps, minimums) are set in steps of this many centidays (half a day).
  POLICY_DAY_STEP_CENTIDAYS: 50,
  MAX_ANNUAL_QUOTA_DAYS: 365,
  MAX_POLICY_DAYS: 365,
  // Steps a joiner's pro-rata credit can be rounded to: a quarter, a half or a whole day.
  PRO_RATA_ROUNDING_STEP_CENTIDAYS: Object.freeze([25, 50, 100]),
  // HR adjustments and encashments: at most this many days in one entry, in hundredths.
  MAX_SINGLE_MOVEMENT_DAYS: 365,
  NOTE_MIN_LENGTH: 3,
  NOTE_MAX_LENGTH: 500,
  PAYROLL_REFERENCE_PATTERN: /^[A-Za-z0-9][A-Za-z0-9._/-]{2,63}$/,
  // Leave years are named by the calendar year they start in.
  EARLIEST_LEAVE_YEAR: 2000,
  LATEST_LEAVE_YEAR: 2100,
  // Sandwich rule across two requests: the longest run of non-working days between them that is
  // still charged (a long festival break is still "between" two leaves; a month off is not).
  MAX_SANDWICH_GAP_DAYS: 15,
  // Request lists (own requests, approval queues, payroll export) return at most this many rows.
  MAX_LIST_ROWS: 200,
  // The leave assistant: one question, and the recent conversation the browser sends with it.
  ASSISTANT_MESSAGE_MAX_LENGTH: 1000,
  ASSISTANT_HISTORY_MAX_MESSAGES: 12,
  ASSISTANT_HISTORY_MESSAGE_MAX_LENGTH: 4000,
});

/** Limits for the work calendar (models/Holiday.js, OfficeLocation weekly offs, services/workCalendar.js). */
export const WORK_CALENDAR_LIMITS = Object.freeze({
  HOLIDAY_NAME_MIN_LENGTH: 2,
  HOLIDAY_NAME_MAX_LENGTH: 100,
  // Offices one holiday can be limited to; more than this is better expressed as company-wide.
  MAX_OFFICES_PER_HOLIDAY: 50,
  // Longest date range one calendar request may cover (one leap year).
  MAX_RANGE_DAYS: 366,
  // A weekday occurs at most five times in a month.
  MAX_WEEKDAY_OCCURRENCE: 5,
});

/** Limits for OKRs (models/Objective.js, models/KeyResult.js). */
export const OKR_FIELD_LIMITS = Object.freeze({
  TITLE_MIN_LENGTH: 3,
  TITLE_MAX_LENGTH: 200,
  DESCRIPTION_MAX_LENGTH: 2000,
  MAX_KEY_RESULTS_PER_OBJECTIVE: 10,
  MAX_MILESTONES_PER_KEY_RESULT: 20,
  // Check-ins (progress updates) kept per key result; older ones are dropped.
  MAX_CHECK_INS_RETAINED: 50,
  CHECK_IN_NOTE_MAX_LENGTH: 500,
  MAX_WEIGHT: 10,
});

/**
 * Department code: 2–20 characters, uppercase letters and digits, optionally separated by "-"
 * or "_", starting with a letter or digit. Examples: "ENG", "FIN-AP", "HR_OPS2".
 * Values are uppercased before this check runs.
 */
export const DEPARTMENT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;

/** A department's address in the app: lowercase words joined by single hyphens ("data-science"). */
export const DEPARTMENT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Finance budget / cost-centre code: 1–40 characters of uppercase letters, digits and the
 * separators "-", "_", "/", "." (covers SAP-style "CC-1001" and ledger-style "4100/ENG.01").
 */
export const BUDGET_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_./-]{0,39}$/;

/**
 * MAC-48 address in canonical form: six pairs of uppercase hex digits separated by colons,
 * e.g. "3C:22:FB:7A:10:9E". Inputs written with "-" separators or lowercase are normalised to this
 * form by the model's setter before the check runs.
 */
export const MAC_ADDRESS_PATTERN = /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/;

/** "#RRGGBB" colours: company brand colours and the payslip accent. */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** A mail domain such as example.com or mail.example.co.in: labels of letters, digits and "-". */
export const EMAIL_DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Limits for models/CompanySettings.js, shared with its request validator. */
export const COMPANY_LIMITS = Object.freeze({
  NAME_MIN_LENGTH: 2,
  NAME_MAX_LENGTH: 120,
  SHORT_CODE_MIN_LENGTH: 2,
  SHORT_CODE_MAX_LENGTH: 6,
  EMAIL_DOMAIN_MAX_LENGTH: 253,
  LOGO_URL_MAX_LENGTH: 2048,
  EMPLOYEE_ID_MIN_DIGITS: 3,
  EMPLOYEE_ID_MAX_DIGITS: 8,
});

/** Limits for employee CSV imports (services/employeeImport*.js). */
export const EMPLOYEE_IMPORT_LIMITS = Object.freeze({
  // 5,000 rows of a dozen short columns fit comfortably in 2 MB.
  MAX_FILE_BYTES: 2 * 1024 * 1024,
  MAX_ROWS: 5_000,
  NAME_MIN_LENGTH: 2,
  NAME_MAX_LENGTH: 100,
  DESIGNATION_MIN_LENGTH: 2,
  DESIGNATION_MAX_LENGTH: 100,
  // Joining dates: past ones for people who already work here, up to a year ahead for new joiners.
  EARLIEST_JOINING_DATE: '1950-01-01',
  MAX_JOINING_DAYS_AHEAD: 366,
  // The validation issues a job summary carries; all of them are in the results.
  ISSUES_IN_SUMMARY: 200,
  RECENT_JOBS_LISTED: 20,
  // A worker holds a job for this long and renews it after every row; a stopped worker's job is
  // picked up again once its lease runs out.
  LEASE_MS: 2 * 60 * 1000,
  SWEEP_INTERVAL_MS: 30 * 1000,
  // Finished jobs (with any activation links still sealed in them) are deleted after this.
  RETENTION_DAYS: 30,
  // Files checked but never started are deleted sooner.
  UNCONFIRMED_RETENTION_DAYS: 7,
});

/**
 * The dashboard (GET /api/dashboard/overview, services/dashboardOverview.js).
 *
 *   RANGES                     the periods it can show: today so far, or the last 7 or 30 days
 *                              including today, in the company's time zone
 *   FIRST_RESPONSE_TARGET_MS   a first reply within this counts as on target ("replies within target")
 *   RECENT_CONVERSATIONS       how many of the latest conversations it lists
 *   UPCOMING_HOLIDAYS          how many coming holidays it lists, looking ahead HOLIDAY_LOOKAHEAD_DAYS
 *   TOP_LEAVE_BALANCES         how many of an employee's leave balances it shows
 *   NEW_ACCOUNTS_DAYS          "new this week": accounts created in this many days
 */
export const DASHBOARD_SETTINGS = Object.freeze({
  RANGES: Object.freeze({ TODAY: 'today', LAST_7_DAYS: '7d', LAST_30_DAYS: '30d' }),
  RANGE_DAYS: Object.freeze({ today: 1, '7d': 7, '30d': 30 }),
  FIRST_RESPONSE_TARGET_MS: 60 * 1000,
  RECENT_CONVERSATIONS: 5,
  UPCOMING_HOLIDAYS: 3,
  HOLIDAY_LOOKAHEAD_DAYS: 365,
  TOP_LEAVE_BALANCES: 3,
  NEW_ACCOUNTS_DAYS: 7,
});

/**
 * The service health check (GET /api/system/health, services/systemHealth.js).
 *
 *   AI_SERVICE_TIMEOUT_MS  how long the AI service's /health may take before it counts as down
 *   EMAIL_CHECK_CACHE_MS   how long an SMTP check is reused, so the page does not connect to the
 *                          mail provider on every load
 *   SLOW_RESPONSE_MS       an answer slower than this marks the service as degraded
 */
export const SYSTEM_HEALTH_SETTINGS = Object.freeze({
  AI_SERVICE_TIMEOUT_MS: 2000,
  EMAIL_CHECK_CACHE_MS: 5 * 60 * 1000,
  SLOW_RESPONSE_MS: 1500,
});

/**
 * Onboarding offers (services/ctcStructure.js, services/offerLetterGenerator.js,
 * services/onboardingService.js). Rates are basis points (5000 = 50%).
 *
 *   ACTIVATION_VALIDITY_HOURS   how long the activation link in a dispatched offer works
 *   CTC_LIMITS                  the annual CTC an offer may state, in rupees
 *   DEFAULT_COMPENSATION_POLICY the company's salary structure until HR changes it:
 *       basicShareBasisPoints           Basic as a share of CTC
 *       hraFiftyPercentCityBasisPoints  HRA as a share of Basic in the 8 cities of
 *                                       HRA_FIFTY_PERCENT_CITIES (utils/payroll/rules.js)
 *       hraOtherCityBasisPoints         HRA as a share of Basic elsewhere
 *       pfOnFullBasic                   PF on the whole Basic instead of the statutory wage ceiling
 *       includeGratuityInCtc            gratuity (GRATUITY_RULES) counted inside the CTC
 *   COMPENSATION_LIMITS         what HR may set those shares to
 *   DEFAULT_OFFER_TERMS         the offer letter's terms until HR changes them (the signatory must
 *                               be set before an offer can be dispatched)
 *   OFFER_TERM_LIMITS           what HR may set the terms to
 */
export const ONBOARDING_SETTINGS = Object.freeze({
  ACTIVATION_VALIDITY_HOURS: 48,
  CTC_LIMITS: Object.freeze({ MIN: 1_00_000, MAX: 10_00_00_000 }),
  WORK_CITY_MAX_LENGTH: 100,
  DRAFT_LIST_LIMIT: 200,
  DEFAULT_COMPENSATION_POLICY: Object.freeze({
    basicShareBasisPoints: 5000,
    hraFiftyPercentCityBasisPoints: 5000,
    hraOtherCityBasisPoints: 4000,
    pfOnFullBasic: false,
    includeGratuityInCtc: false,
  }),
  COMPENSATION_LIMITS: Object.freeze({
    BASIC_SHARE_MIN_BASIS_POINTS: 3000,
    BASIC_SHARE_MAX_BASIS_POINTS: 7000,
    HRA_MAX_BASIS_POINTS: 5000,
  }),
  DEFAULT_OFFER_TERMS: Object.freeze({
    probationMonths: 6,
    noticePeriodDays: 60,
    weeklyWorkingHours: 40,
    offerValidityDays: 7,
    signatoryName: null,
    signatoryTitle: null,
    additionalClauses: Object.freeze([]),
  }),
  OFFER_TERM_LIMITS: Object.freeze({
    PROBATION_MONTHS_MAX: 12,
    NOTICE_PERIOD_DAYS_MAX: 180,
    WEEKLY_WORKING_HOURS_MAX: 48,
    OFFER_VALIDITY_DAYS_MAX: 60,
    SIGNATORY_MAX_LENGTH: 100,
    CLAUSES_MAX: 10,
    CLAUSE_MAX_LENGTH: 600,
  }),
});

/** Offer letter PDF protection (services/offerLetterGenerator.js): qpdf, AES-256. */
export const OFFER_LETTER_PROTECTION = Object.freeze({
  KEY_LENGTH_BITS: 256,
  // The candidate opens the letter with their date of birth written DDMMYYYY.
  PASSWORD_FORMAT_LABEL: 'DDMMYYYY',
  QPDF_TIMEOUT_MS: 30_000,
});

/**
 * Department knowledge bases (models/DepartmentAgent.js, models/AgentDocument.js,
 * services/knowledge/*): what a department lead may upload and how documents are processed.
 */
export const KNOWLEDGE_BASE_SETTINGS = Object.freeze({
  AGENT_NAME_MAX_LENGTH: 120,
  // Department instructions for the agent; long enough for detailed guidelines, short enough to
  // leave most of the model's context for the department's documents.
  SYSTEM_PROMPT_MAX_LENGTH: 4_000,
  MAX_FILE_BYTES: 10 * 1024 * 1024,
  // The file types a knowledge base accepts: media type → extension. The type is decided from the
  // file's content (services/knowledge/fileTypes.js), never from what the browser declared.
  FILE_TYPES: Object.freeze({
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'text/markdown': 'md',
    'text/plain': 'txt',
  }),
  // A .docx is a zip: its parts may hold at most this much once unpacked, in at most this many
  // entries, so a small "zip bomb" cannot exhaust the server's memory.
  DOCX_MAX_UNPACKED_BYTES: 50 * 1024 * 1024,
  DOCX_MAX_ENTRIES: 2_000,
  // Bounds on the work one document may cause: pages read from a PDF, and text kept from any file.
  PDF_MAX_PAGES: 1_000,
  EXTRACTED_TEXT_MAX_CHARS: 5_000_000,
  // Reading a file runs in its own thread (services/knowledge/extractionThread.js), stopped when it
  // takes longer than this or needs more memory, so a hostile file cannot stall or exhaust the API.
  EXTRACTION_TIMEOUT_MS: 60_000,
  EXTRACTION_MAX_HEAP_MB: 256,
  // Chunks: about this long (a few paragraphs), never longer than CHUNK_MAX_CHARS (within the
  // embedding model's 512-token input), each starting with the end of the previous one in the
  // same section, so a sentence cut at a boundary is still found whole.
  CHUNK_TARGET_CHARS: 1_200,
  CHUNK_MAX_CHARS: 1_800,
  CHUNK_OVERLAP_CHARS: 200,
  // A heading kept with a chunk is cut to this length (the AI service accepts up to 500 characters).
  HEADING_MAX_CHARS: 300,
  // Chunks sent to the AI service per indexing request: at most about 30 KB of text, well inside
  // the 1 MB request cap of services/aiServiceClient.js. Embedding 32 chunks of the largest size
  // took about 5 s on a desktop CPU, so 16 keeps a request within AI_SERVICE_TIMEOUT_MS on a small
  // 2-vCPU server.
  INDEX_BATCH_SIZE: 16,
  ORIGINAL_NAME_MAX_LENGTH: 255,
  MAX_DOCUMENTS_PER_DEPARTMENT: 200,
  // The lead picker (GET /agent/lead-candidates): people listed per request, and the longest search.
  LEAD_CANDIDATES_LIMIT: 50,
  LEAD_SEARCH_MAX_LENGTH: 100,
  MAX_CHUNKS_PER_DOCUMENT: 2_000,
  // A failed document keeps this much of the reason, for the lead to read.
  ERROR_MESSAGE_MAX_LENGTH: 500,
  // A worker holds a document for this long while it processes it; a stopped worker's document
  // is picked up again by the sweep once its lease runs out.
  LEASE_MS: 5 * 60 * 1000,
  SWEEP_INTERVAL_MS: 30 * 1000,
  // Processing attempts before a document is marked FAILED.
  MAX_ATTEMPTS: 3,
});
