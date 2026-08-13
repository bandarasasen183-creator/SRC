// Shared app state. Kept deliberately tiny.

export const state = {
  user: null,      // Firebase Auth user
  profile: null,   // users/{uid} document
  rosterEmails: [] // teachers only; used for response counts
};

export const isTeacher = () => state.profile?.role === 'teacher';
