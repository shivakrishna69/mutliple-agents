/** Recognising MongoDB server errors the code handles on purpose. */

const DUPLICATE_KEY_ERROR_CODE = 11000;

/** True when a write was refused by a unique index (E11000). */
export const isDuplicateKeyError = (error) => error?.code === DUPLICATE_KEY_ERROR_CODE;
