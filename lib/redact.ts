/** Addresses are the private part of a public brief. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export const redactEmails = (text: string) => text.replace(EMAIL, "[email]");

/** A link to show on a public surface, or null when it carries an address (a `?email=` in a document's URL). */
export const safeUrl = (url: string | undefined) => (url && redactEmails(url) === url ? url : null);
