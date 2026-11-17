/**
 * Email Sender Interface
 * Default implementation is log-only, avoiding dependencies on external SMTP.
 * Never logs plaintext passwords or raw authentication tokens.
 */
export class EmailSender {
  async send({ to, subject, template, data }) {
    throw new Error("send() must be implemented by concrete EmailSender");
  }
}

export class LogOnlyEmailSender extends EmailSender {
  constructor() {
    super();
    this.sentEmails = [];
  }

  async send({ to, subject, template, data }) {
    // Record email receipt safely
    const record = {
      to,
      subject,
      template,
      timestamp: Date.now(),
      // Store token only for test extraction; in real logs it is omitted
      hasToken: Boolean(data?.token),
      token: data?.token || null,
    };
    this.sentEmails.push(record);

    console.log(`[EmailSender:Log] Template='${template}' To='${to}' Subject='${subject}' (Token omitted from stdout)`);
    return { ok: true, messageId: `log-${Date.now()}` };
  }

  getLastEmail() {
    return this.sentEmails[this.sentEmails.length - 1] || null;
  }

  clear() {
    this.sentEmails = [];
  }
}

let senderInstance = null;

export function getEmailSender() {
  if (!senderInstance) {
    senderInstance = new LogOnlyEmailSender();
  }
  return senderInstance;
}

export function resetEmailSenderForTest() {
  senderInstance = new LogOnlyEmailSender();
  return senderInstance;
}
