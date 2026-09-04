const poolData = {
  UserPoolId: window.APP_CONFIG.USER_POOL_ID,
  ClientId: window.APP_CONFIG.USER_POOL_CLIENT_ID,
};
const userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);

const Auth = {
  signUp(email, password) {
    return new Promise((resolve, reject) => {
      userPool.signUp(email, password, [], null, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  },

  signIn(email, password) {
    const authDetails = new AmazonCognitoIdentity.AuthenticationDetails({
      Username: email,
      Password: password,
    });
    const user = new AmazonCognitoIdentity.CognitoUser({ Username: email, Pool: userPool });
    return new Promise((resolve, reject) => {
      user.authenticateUser(authDetails, {
        onSuccess: (session) => resolve(session),
        onFailure: (err) => reject(err),
      });
    });
  },

  signOut() {
    const user = userPool.getCurrentUser();
    if (user) user.signOut();
  },

  getSession() {
    return new Promise((resolve, reject) => {
      const user = userPool.getCurrentUser();
      if (!user) return reject(new Error("Not signed in"));
      user.getSession((err, session) => {
        if (err) return reject(err);
        resolve(session);
      });
    });
  },

  getIdToken() {
    return this.getSession().then((session) => session.getIdToken().getJwtToken());
  },

  // The pool's UsernameAttributes:[email] setting makes Cognito assign an
  // auto-generated UUID as the real "Username" internally (email is only a
  // sign-in alias) - so CognitoUser.getUsername() returns that UUID, not
  // the email. The ID token's `email` claim is the only reliable source.
  currentUserEmail() {
    return this.getSession()
      .then((session) => session.getIdToken().decodePayload().email)
      .catch(() => null);
  },

  // Old/new password go straight to Cognito over SRP - our own backend
  // never sees or stores either value, old or new.
  changePassword(oldPassword, newPassword) {
    return new Promise((resolve, reject) => {
      const user = userPool.getCurrentUser();
      if (!user) return reject(new Error("Not signed in"));
      user.getSession((err) => {
        if (err) return reject(err);
        user.changePassword(oldPassword, newPassword, (err2, result) => {
          if (err2) return reject(err2);
          resolve(result);
        });
      });
    });
  },
};
