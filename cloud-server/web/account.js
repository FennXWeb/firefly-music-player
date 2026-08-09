import { createAuthClient } from 'better-auth/client';
import { emailOTPClient, phoneNumberClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';

const auth = createAuthClient({ baseURL: location.origin, plugins: [emailOTPClient(), phoneNumberClient(), passkeyClient()] });
const $ = selector => document.querySelector(selector);
let method = 'password';
let mode = new URLSearchParams(location.search).get('mode') === 'signup' ? 'signup' : 'signin';
let pendingEmailVerification = false;
let resettingPassword = false;

function identifierKind(value) { return value.includes('@') ? 'email' : 'phone'; }
function showMessage(value, good = false) { const element=$('#message');element.textContent=value||'';element.style.color=good?'#83c998':'#dc8778'; }
function unwrap(result) { if (result?.error) throw new Error(result.error.message || 'Authentication could not be completed.');return result?.data; }
function updateForm() {
  const passkey = method === 'passkey', code = method === 'code';
  $('#identifier').closest('label').classList.toggle('hidden', passkey);
  $('#passwordField').classList.toggle('hidden', method !== 'password' && !resettingPassword);
  $('#codeField').classList.toggle('hidden', !code && !resettingPassword);
  $('#sendCode').classList.toggle('hidden', !code && !resettingPassword);
  $('#nameField').classList.toggle('hidden', !(mode === 'signup' && method === 'password' && !resettingPassword));
  $('#formTitle').textContent = resettingPassword ? 'Set a secure password' : mode === 'signup' ? 'Create your Ignifire account' : 'Sign in to Ignifire';
  $('#submitAuth').textContent = resettingPassword ? 'Save password' : passkey ? 'Continue with a passkey' : code ? 'Verify & continue' : mode === 'signup' ? 'Create account' : 'Sign in';
  $('#switchCopy').textContent = mode === 'signup' ? 'Already have an account?' : 'New to Ignifire?';
  $('#switchMode').textContent = mode === 'signup' ? 'Sign in' : 'Create an account';
  $('#switchMode').closest('.switch-mode').classList.toggle('hidden', resettingPassword);
  $('#resetPassword').textContent = resettingPassword ? 'Back to sign in' : 'Set or reset a password';
  showMessage('');
}
async function refreshSession() {
  const session = unwrap(await auth.getSession());
  const user = session?.user;
  $('#signedOut').classList.toggle('hidden', Boolean(user));
  $('#signedIn').classList.toggle('hidden', !user);
  if (user) { $('#userName').textContent=user.name||'Ignifire listener';$('#userIdentity').textContent=user.phoneNumber||(!/@phone\.(?:firefly|ignifire)\.invalid$/i.test(String(user.email||''))?user.email:'')||'Secure account'; }
  return user;
}

document.querySelectorAll('[data-auth-method]').forEach(button => button.onclick = () => {resettingPassword=false;method=button.dataset.authMethod;document.querySelectorAll('[data-auth-method]').forEach(item=>item.classList.toggle('active',item===button));updateForm()});
$('#switchMode').onclick=()=>{resettingPassword=false;mode=mode==='signup'?'signin':'signup';updateForm()};
$('#resetPassword').onclick=()=>{resettingPassword=!resettingPassword;mode='signin';method=resettingPassword?'code':'password';document.querySelectorAll('[data-auth-method]').forEach(item=>item.classList.toggle('active',item.dataset.authMethod===method));updateForm()};
$('#sendCode').onclick=async()=>{const identifier=$('#identifier').value.trim();if(!identifier)return showMessage('Enter an email address or phone number first.');try{if(resettingPassword){if(identifierKind(identifier)==='email')unwrap(await auth.emailOtp.requestPasswordReset({email:identifier}));else unwrap(await auth.phoneNumber.requestPasswordReset({phoneNumber:identifier}));}else if(identifierKind(identifier)==='email')unwrap(await auth.emailOtp.sendVerificationOtp({email:identifier,type:pendingEmailVerification?'email-verification':'sign-in'}));else unwrap(await auth.phoneNumber.sendOtp({phoneNumber:identifier}));showMessage(`A code was sent to ${identifier}.`,true);$('#otp').focus()}catch(error){showMessage(error.message)}};
$('#authForm').onsubmit=async event=>{event.preventDefault();showMessage('');const identifier=$('#identifier').value.trim(),password=$('#password').value,otp=$('#otp').value.trim(),name=$('#displayName').value.trim()||'Ignifire listener';try{
  if(resettingPassword){if(!otp||password.length<10)throw new Error('Enter the code and a password of at least 10 characters.');if(identifierKind(identifier)==='email')unwrap(await auth.emailOtp.resetPassword({email:identifier,otp,password}));else unwrap(await auth.phoneNumber.resetPassword({phoneNumber:identifier,otp,newPassword:password}));resettingPassword=false;method='password';updateForm();showMessage('Password saved. You can sign in now.',true);return;}
  if(method==='passkey')unwrap(await auth.signIn.passkey());
  else if(method==='code'){if(!otp)throw new Error('Enter the code that was sent to you.');if(identifierKind(identifier)==='email'&&pendingEmailVerification){unwrap(await auth.emailOtp.verifyEmail({email:identifier,otp}));unwrap(await auth.signIn.email({email:identifier,password,rememberMe:true}));pendingEmailVerification=false}else if(identifierKind(identifier)==='email')unwrap(await auth.signIn.emailOtp({email:identifier,otp,name}));else unwrap(await auth.phoneNumber.verify({phoneNumber:identifier,code:otp,disableSession:false,updatePhoneNumber:false}));}
  else if(mode==='signup'){if(identifierKind(identifier)!=='email')throw new Error('Create phone-number accounts with a one-time code, then add a password from account security.');unwrap(await auth.signUp.email({email:identifier,password,name}));pendingEmailVerification=true;method='code';document.querySelectorAll('[data-auth-method]').forEach(item=>item.classList.toggle('active',item.dataset.authMethod==='code'));updateForm();showMessage('Enter the verification code sent to your email.',true);$('#otp').focus();return;}
  else if(identifierKind(identifier)==='email')unwrap(await auth.signIn.email({email:identifier,password,rememberMe:true}));
  else unwrap(await auth.signIn.phoneNumber({phoneNumber:identifier,password,rememberMe:true}));
  await refreshSession();
}catch(error){showMessage(error.message)}};
$('#createConnection').onclick=async()=>{try{const response=await fetch('/v1/desktop/issue',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),payload=await response.json();if(!response.ok)throw new Error(payload.error||'Could not create a connection code.');$('#connectionCode').textContent=payload.code;$('#connectionPanel').classList.remove('hidden')}catch(error){alert(error.message)}};
$('#copyConnection').onclick=async()=>{await navigator.clipboard.writeText($('#connectionCode').textContent);$('#copyConnection').textContent='Copied'};
$('#addPasskey').onclick=async()=>{try{unwrap(await auth.passkey.addPasskey({name:`Ignifire passkey · ${new Date().toLocaleDateString()}`}));alert('Passkey added successfully.')}catch(error){alert(error.message)}};
$('#signOut').onclick=async()=>{await auth.signOut();await refreshSession()};

updateForm();refreshSession().catch(error=>showMessage(error.message));
