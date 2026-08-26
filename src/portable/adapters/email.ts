import nodemailer, { type Transporter } from "nodemailer";
import type { PortableConfig } from "../config";
import type { EmailMessage, EmailSender } from "../contracts";

export class DisabledEmailSender implements EmailSender {
  readonly configured = false;

  send(): Promise<void> {
    return Promise.reject(new Error("email_delivery_not_configured"));
  }

  check(): Promise<void> {
    return Promise.resolve();
  }
}

export class SmtpEmailSender implements EmailSender {
  readonly configured = true;
  private readonly transporter: Transporter;
  private readonly from: { address: string; name: string };

  constructor(config: PortableConfig) {
    if (!config.SMTP_HOST || !config.EMAIL_FROM_ADDRESS) {
      throw new Error("SMTP configuration was not validated.");
    }
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER && config.SMTP_PASSWORD
        ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
        : undefined,
    });
    this.from = {
      address: config.EMAIL_FROM_ADDRESS,
      name: config.EMAIL_FROM_NAME ?? config.APP_NAME,
    };
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.from, ...message });
  }

  async check(): Promise<void> {
    await this.transporter.verify();
  }
}

export function createEmailSender(config: PortableConfig): EmailSender {
  return config.EMAIL_MODE === "smtp" ? new SmtpEmailSender(config) : new DisabledEmailSender();
}
