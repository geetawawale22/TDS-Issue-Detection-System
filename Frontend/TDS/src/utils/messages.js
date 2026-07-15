// Centralized notification copy so toasts read consistently across the app.
export const MESSAGES = {
  USER_CREATED: 'User created successfully.',
  INVITE_EMAIL_FAILED: 'User created, but the invite email could not be delivered. Share the set-password link with them manually, or check spam/IT filtering.',
  USER_UPDATED: 'User updated successfully.',
  USER_DELETED: (name) => `${name} deleted successfully.`,
  PROFILE_UPDATED: 'Profile updated successfully.',
  ACTIVATION_UPDATED: (name, active) => `${name} ${active ? 'activated' : 'deactivated'} successfully.`,
  COMPANY_CODE_UPDATED: 'Company code access updated.',
  PASSWORD_CHANGED: 'Password changed successfully.',
  PASSWORD_SET: 'Password set successfully. You can now log in.',
  EMAIL_SENT: 'If an account exists for this email, a reset link has been sent.',
  LOGIN_SUCCESS: (name) => `Welcome back, ${name}!`,
  LOGOUT_SUCCESS: 'Signed out successfully.',
  SESSION_EXPIRED: 'Your session has expired. Please sign in again.',
  INVALID_EMAIL: 'Enter a valid email address.',
  REQUIRED_FIELD: 'This field is required.',
  VALIDATION_ERROR: 'Please fix the highlighted fields and try again.',
  UNEXPECTED_ERROR: 'Something went wrong. Please try again.',
}

export default MESSAGES
