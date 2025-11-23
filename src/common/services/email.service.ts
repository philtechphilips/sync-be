import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { config } from '../../config/config.service';

@Injectable()
export class EmailService {
  private transporter: nodemailer.Transporter;

  constructor() {
    // Gmail SMTP Configuration - Using explicit SMTP settings
    // Alternative: You can also use OAuth2 (requires googleapis package)

    this.transporter = nodemailer.createTransport({
      host: config.SMTP.HOST || 'smtp.gmail.com',
      port: config.SMTP.PORT || 587,
      auth: {
        user: config.SMTP.USER,
        pass: config.SMTP.PASS,
      },
    });
  }

  // Verify SMTP connection (useful for debugging)
  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      console.log('SMTP server is ready to send emails');
      return true;
    } catch (error) {
      console.error('SMTP connection verification failed:', error);
      return false;
    }
  }

  async sendPasswordResetEmail(
    email: string,
    resetToken: string,
  ): Promise<void> {
    const resetUrl = `${config.FRONTEND_URL}/auth/reset-password?token=${resetToken}`;

    const mailOptions = {
      from: `"Groom API" <${config.SMTP.FROM}>`,
      to: email,
      subject: 'Password Reset Request',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Password Reset</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: #f4f4f4; padding: 20px; border-radius: 5px;">
            <h2 style="color: #333; margin-top: 0;">Password Reset Request</h2>
            <p>Hello,</p>
            <p>You have requested to reset your password. Click the button below to reset your password:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetUrl}" style="background-color: #007bff; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Reset Password</a>
            </div>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #007bff;">${resetUrl}</p>
            <p>This link will expire in 1 hour.</p>
            <p>If you did not request this password reset, please ignore this email.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
            <p style="color: #666; font-size: 12px;">This is an automated message, please do not reply.</p>
          </div>
        </body>
        </html>
      `,
      text: `
        Password Reset Request
        
        Hello,
        
        You have requested to reset your password. Please click the link below to reset your password:
        
        ${resetUrl}
        
        This link will expire in 1 hour.
        
        If you did not request this password reset, please ignore this email.
      `,
    };

    try {
      // Verify connection before sending (optional, can be removed in production)
      await this.verifyConnection();

      await this.transporter.sendMail(mailOptions);
      console.log(`Password reset email sent successfully to ${email}`);
    } catch (error) {
      console.error('Error sending email:', error);
      console.error('Full error details:', JSON.stringify(error, null, 2));

      // Provide helpful error message for authentication issues
      const errorMessage = error.message || String(error);
      if (
        errorMessage.includes('Invalid login') ||
        errorMessage.includes('535-5.7.8') ||
        errorMessage.includes('BadCredentials')
      ) {
        throw new Error(
          `Email authentication failed. Please verify:\n` +
            `1. SMTP_USER is your full Gmail address (e.g., yourname@gmail.com)\n` +
            `2. SMTP_PASS is a valid 16-character App Password (generate at: https://myaccount.google.com/apppasswords)\n` +
            `3. 2-Step Verification is enabled on your Google account\n` +
            `4. The App Password was copied correctly (no spaces or extra characters)\n` +
            `Original error: ${errorMessage}`,
        );
      }

      throw new Error(`Failed to send password reset email: ${errorMessage}`);
    }
  }
}
