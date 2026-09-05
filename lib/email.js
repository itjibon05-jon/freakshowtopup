/**
 * FREAKSHOWTOPUP - Automated Email Dispatch Engine
 * Delivers order completion notifications and invoices directly to customer Gmail.
 */

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '465');
  const user = process.env.SMTP_USER || process.env.EMAIL_USER || '';
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS || '';

  if (!user || !pass) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });

  return transporter;
}

/**
 * Send Order Delivered Confirmation Email to Customer
 */
async function sendOrderDeliveredEmail(order, note = '') {
  const recipient = order.playerUid && order.playerUid.includes('@') 
    ? order.playerUid 
    : (order.userEmail || '');

  if (!recipient || !recipient.includes('@')) {
    console.log(`[Email] No valid email address found for Order #${order.id}`);
    return { success: false, reason: 'NO_EMAIL' };
  }

  const mailer = getTransporter();
  const fromAddress = process.env.FROM_EMAIL || process.env.SMTP_USER || 'support@freakshowtopup.shop';
  const siteName = 'FREAKSHOW TOP-UP';

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0e17; color: #f1f5f9; margin: 0; padding: 24px; }
        .card { max-width: 560px; margin: 0 auto; background: #111827; border: 1px solid #1e293b; border-radius: 16px; padding: 32px; box-shadow: 0 12px 36px rgba(0,0,0,0.5); }
        .header { text-align: center; border-bottom: 1px solid #1e293b; padding-bottom: 20px; margin-bottom: 24px; }
        .title { color: #00f2fe; font-size: 22px; font-weight: 800; margin: 0; }
        .badge { display: inline-block; background: #059669; color: #fff; font-size: 12px; font-weight: 800; padding: 4px 12px; border-radius: 20px; margin-top: 10px; }
        .item-box { background: #1a2234; border: 1px solid #334155; border-radius: 10px; padding: 18px; margin: 20px 0; }
        .row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; }
        .label { color: #94a3b8; }
        .value { color: #fff; font-weight: 700; }
        .note { background: rgba(0,242,254,0.08); border-left: 4px solid #00f2fe; padding: 12px; border-radius: 4px; font-size: 13px; color: #e2e8f0; margin-top: 16px; }
        .footer { text-align: center; margin-top: 28px; font-size: 12px; color: #64748b; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <h1 class="title">🎮 ${siteName}</h1>
          <div class="badge">✅ ORDER DELIVERED</div>
        </div>

        <p style="font-size: 15px; line-height: 1.5;">Hello <b>${order.userName || 'Valued Gamer'}</b>,</p>
        <p style="font-size: 14px; color: #cbd5e1; line-height: 1.5;">
          Your digital order has been completed and successfully delivered!
        </p>

        <div class="item-box">
          <div class="row">
            <span class="label">Order ID:</span>
            <span class="value">#${order.id}</span>
          </div>
          <div class="row">
            <span class="label">Product:</span>
            <span class="value">${order.productName || order.productId}</span>
          </div>
          <div class="row">
            <span class="label">Delivery Target:</span>
            <span class="value">${order.playerUid || order.userEmail || 'N/A'}</span>
          </div>
          <div class="row">
            <span class="label">Amount Paid:</span>
            <span class="value">৳${order.sellingPrice} ${order.currency || 'BDT'}</span>
          </div>
          <div class="row">
            <span class="label">Status:</span>
            <span class="value" style="color: #34d399;">COMPLETED & DELIVERED</span>
          </div>
          ${order.unipinCode || order.pinCode ? `
          <div class="row" style="margin-top: 10px; border-top: 1px dashed #334155; padding-top: 10px;">
            <span class="label">Digital Code / PIN:</span>
            <span class="value" style="color: #facc15; font-family: monospace; font-size: 15px;">${order.unipinCode || order.pinCode}</span>
          </div>` : ''}
        </div>

        ${note ? `
        <div class="note">
          <b>Admin Note:</b> ${note}
        </div>` : ''}

        <p style="font-size: 13px; color: #94a3b8; text-align: center; margin-top: 24px;">
          Thank you for choosing ${siteName}. You can track all your orders and download your receipts on our website anytime!
        </p>

        <div class="footer">
          &copy; ${new Date().getFullYear()} ${siteName} • All rights reserved.<br>
          Website: <a href="https://freakshowtopup.shop" style="color: #00f2fe; text-decoration: none;">freakshowtopup.shop</a>
        </div>
      </div>
    </body>
    </html>
  `;

  if (!mailer) {
    console.log(`[Email Dispatcher] (SMTP credentials not yet configured in .env - Logging dispatch payload)`);
    console.log(`[Email Mock Delivery] -> To: ${recipient}, Order: #${order.id}, Product: ${order.productName}`);
    return { success: true, simulated: true, recipient };
  }

  try {
    const info = await mailer.sendMail({
      from: `"${siteName}" <${fromAddress}>`,
      to: recipient,
      subject: `✅ Order #${order.id} Delivered - ${order.productName || 'Your Purchase'}`,
      html: htmlContent
    });
    console.log(`[Email] Successfully delivered email to ${recipient} (MsgID: ${info.messageId})`);
    return { success: true, messageId: info.messageId, recipient };
  } catch (err) {
    console.error(`[Email] Failed to send email to ${recipient}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  sendOrderDeliveredEmail
};
