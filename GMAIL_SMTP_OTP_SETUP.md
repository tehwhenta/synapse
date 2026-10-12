# Gmail SMTP and OTP setup for Synapse

Use your existing Supabase project. Gmail credentials belong only in Supabase's SMTP settings, never in the Vue app, a `VITE_*` variable, a screenshot, or this chat.

## 1. Generate a Google app password

1. Sign in to the Gmail account you created for Synapse.
2. Open [Google Account Security](https://myaccount.google.com/security).
3. Under **How you sign in to Google**, enable **2-Step Verification** and complete Google's verification steps.
4. Open [App passwords](https://myaccount.google.com/apppasswords) while signed in to that same account.
5. Enter **Synapse Supabase SMTP** as the app name and click **Create**.
6. Use the generated app password in Supabase. Remove the separating spaces when entering it. Do not use your normal Google account password.

Google requires 2-Step Verification for app passwords. Some managed accounts, security-key-only configurations, and Advanced Protection accounts do not offer them. If unavailable, use an SMTP provider supported by your account's policies; do not disable account security. Changing the main Google password revokes existing app passwords, so generate a new one and update Supabase afterward. [Google app-password guidance](https://support.google.com/accounts/answer/185833)

## 2. Connect Gmail to Supabase

1. Open your project in the [Supabase Dashboard](https://supabase.com/dashboard).
2. Go to **Authentication -> Emails -> SMTP settings**. Some dashboard versions label the section **Email** or place SMTP settings alongside email templates.
3. Enable **Custom SMTP**.
4. Enter the following values:

| Supabase field | Value |
| --- | --- |
| Sender email address | The complete Gmail address you created for Synapse |
| Sender name | `Synapse` |
| Host | `smtp.gmail.com` |
| Port number | `465` |
| Username | That same complete Gmail address |
| Password | The Google app password from step 1, without spaces |
| Minimum interval per user | `60` seconds, if this field is shown |

5. Save. If a separate encryption setting appears, choose **SSL/TLS** for port 465. Port 587 with **STARTTLS** is the alternative; do not use unencrypted SMTP.

The sender address should match the Gmail account, not an invented `no-reply` address. [Google SMTP server settings](https://developers.google.com/workspace/gmail/imap/imap-smtp), [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)

## 3. Keep email confirmation on

1. Open **Authentication -> Sign In / Providers -> Email** (or **Providers -> Email**).
2. Keep email/password sign-in enabled.
3. Turn **Confirm email ON** and save. Without this, signup immediately signs users in and does not request an OTP.
4. Find **Email OTP expiry** in the Email provider settings. Set it to **600 seconds / 10 minutes**, or your preferred short lifetime.
5. Leave your chosen OTP length as configured. The application does not assume a particular digit count.

Signup still uses email and password. The OTP confirms ownership of the email address; normal sign-in remains email and password. Forgotten-password requests require their own OTP before showing the new-password form.

## 4. Replace both email templates

Open **Authentication -> Emails -> Templates** (sometimes **Email Templates**). Update these two templates separately and save each one:

| Template | Subject | Full HTML file in this project |
| --- | --- | --- |
| Confirm sign up | `Your Synapse email confirmation code` | `supabase/templates/confirm-signup.html` |
| Reset password | `Your Synapse password reset code` | `supabase/templates/reset-password.html` |

Open the HTML file in a text editor, select its entire contents, and paste that HTML into the matching template's **Body / Content** editor, replacing the old content. Paste the code, not the filename.

Both templates display **`{{ .Token }}`**. Neither includes `{{ .ConfirmationURL }}`, a confirmation button, or a reset link. Use the exact placeholder, including the dot. Do not substitute `{{ .TokenHash }}`: the hashed token is not the OTP users enter. The wording says **OTP** or **code**, without specifying a digit count. [Supabase template variables](https://supabase.com/docs/guides/auth/auth-email-templates)

The app verifies signup codes with `verifyOtp({ email, token, type: 'email' })` and recovery codes with `type: 'recovery'`. Editing email templates alone is not enough; install the updated frontend too. Room invitation links remain links, because they are a separate space-sharing feature. [Supabase OTP verification](https://supabase.com/docs/reference/javascript/auth-verifyotp)

## 5. Review sending limits

1. Open **Authentication -> Rate Limits**.
2. Find the limit for **emails sent**.
3. Start with **30 emails per hour** for testing or a small class. Raise it deliberately only when your expected usage and Gmail capacity allow it.
4. Keep the per-user resend interval at **60 seconds**. The frontend also has a cooldown; Supabase remains the authoritative enforcement.

Custom SMTP replaces Supabase's built-in two-email-per-hour restriction; it does not make delivery unlimited. Supabase documents a low initial custom-SMTP limit of 30 emails per hour, which you can adjust. [Supabase SMTP limits](https://supabase.com/docs/guides/auth/auth-smtp), [Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits)

Personal Gmail also has daily sending and abuse limits. Google documents blocks for excessive daily sending and notes that sending can remain blocked for 1-24 hours. New accounts or unusual traffic may face additional restrictions. Gmail is suitable for a small pilot; a transactional email provider is a better choice as the system grows. [Gmail sending limits](https://support.google.com/mail/answer/22839)

## 6. Keep your app URLs configured

In **Authentication -> URL Configuration**:

- Local testing Site URL: `http://localhost:5173`.
- Keep `http://localhost:5173/**` in Redirect URLs.
- Keep your actual deployed frontend's URL in the allowlist as well. Set Site URL to that domain when using the deployed app.

The new code-entry flows do not ask users to open an email link, but valid URLs remain useful for supported legacy links and other auth flows. Do not change your project's public key, database password, RLS, or cleanup schedule for SMTP.

## 7. Install and test

1. Follow the matching upgrade path in `UPGRADE_GUIDE.md`. Current **1.3** needs `004_reviewer_accounts.sql`, updated functions, and the schedule update described in `VERCEL_SUPABASE_DEPLOY.md`. The earlier **1.1 -> 1.2** change alone needed no SQL once `003` succeeded.
2. Run `npm install`, then `npm run dev` in the updated project.
3. Register a **new test account with an inbox you control**. Check Inbox and Spam. The app should show **Confirm your email** and an OTP input. The email should contain a code, not an auth link.
4. Enter the full code. The account should enter its workspace.
5. Sign out. Choose **Forgot password?**, request a code, and enter it. Only then should **New password** and **Confirm new password** appear.
6. Complete the reset, sign out, and sign in with the new password.
7. Test an incorrect code and **Resend code** after the cooldown. Use the code from the latest email.

Already-confirmed accounts do not need to confirm their email again. An older unconfirmed account can use **Confirm an existing account** on the sign-in screen. This resends its signup code; it does not create a different account.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Email still contains a link | Save the correct **Confirm sign up** or **Reset password** template in the same project used by your app. Both must use `{{ .Token }}`. |
| No OTP screen after signup | Confirm email must be ON, and the updated `src/` must be installed. Confirmed existing accounts do not get a new signup challenge. |
| SMTP authentication / username-password error | Full Gmail address as username and sender; Google app password without spaces; 2-Step Verification enabled. |
| Sending stopped after changing Google's password | Generate a new app password and update the SMTP password in Supabase. |
| Rate-limit error / HTTP 429 | Check Supabase Auth Rate Limits, wait through the resend cooldown, and check Gmail's sending limits. Do not keep retrying rapidly. |
| `Error sending confirmation email` | Open **Authentication -> Logs** for the detailed mail error. Verify SMTP host, port, password, and sender address. |
| Code invalid or expired | Use the latest email, enter the entire code, and request another after the cooldown if needed. |
| App password option unavailable | Confirm the correct Google account and 2-Step Verification; managed-account or security policies may require another mail provider. |
| No delivery but no visible error | Check Spam, Gmail Sent, the recipient address, and Supabase Auth Logs. |

Keep database **RLS ON**. Keep the existing Edge Function **Verify JWT OFF** setting: those functions authenticate explicitly. SMTP and OTP settings do not change either security policy.
