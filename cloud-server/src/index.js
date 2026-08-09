import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { toNodeHandler } from 'better-auth/node';
import { auth, pool, publicURL, publicWebURL } from './auth.js';
import { requireDesktopAuth, requireWebAuth, revokeDesktopAuth, issueDesktopCode, claimDesktopCode, me, getWebLibrary, headObject, putObject, getObject, streamWebObject, putSnapshot, getSnapshot } from './storage.js';

const app=express(),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),port=Number(process.env.PORT||3000);
app.set('trust proxy',1);
app.use(cors({
  origin(origin,callback){
    if(!origin||origin===publicURL||origin===publicWebURL)return callback(null,true);
    callback(new Error('This origin is not allowed to access Ignifire accounts.'));
  },
  credentials:true,
  methods:['GET','HEAD','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders:['Authorization','Content-Type','Range','X-Ignifire-Filename','X-Firefly-Filename'],
  exposedHeaders:['Accept-Ranges','Content-Length','Content-Range','Content-Type']
}));
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'",'data:'],connectSrc:["'self'"],fontSrc:["'self'"],objectSrc:["'none'"],baseUri:["'none'"],frameAncestors:["'none'"]}}}));
app.all('/api/auth/*splat',toNodeHandler(auth));
app.use(express.static(path.join(root,'public'),{index:false,maxAge:process.env.NODE_ENV==='production'?'1h':0}));
app.get('/account',(_req,res)=>res.sendFile(path.join(root,'public','account.html')));
app.get('/health',async(_req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,service:'ignifire-cloud'})}catch{res.status(503).json({ok:false})}});
app.put('/v1/sync/objects/:hash',requireDesktopAuth,express.raw({type:'application/octet-stream',limit:'150mb'}),putObject);
app.use(express.json({limit:'150mb'}));
app.post('/v1/desktop/issue',issueDesktopCode);
app.post('/v1/desktop/claim',claimDesktopCode);
app.delete('/v1/desktop/session',requireDesktopAuth,revokeDesktopAuth);
app.get('/v1/me',requireDesktopAuth,me);
app.get('/v1/web/library',requireWebAuth,getWebLibrary);
app.get('/v1/web/stream/:hash',requireWebAuth,streamWebObject);
app.head('/v1/sync/objects/:hash',requireDesktopAuth,headObject);
app.get('/v1/sync/objects/:hash',requireDesktopAuth,getObject);
app.put('/v1/sync/snapshot',requireDesktopAuth,putSnapshot);
app.get('/v1/sync/snapshot',requireDesktopAuth,getSnapshot);
app.use((_req,res)=>res.status(404).json({error:'Not found.'}));
app.use((error,_req,res,_next)=>{console.error(error);res.status(500).json({error:process.env.NODE_ENV==='production'?'The Ignifire account service could not complete that request.':error.message})});
app.listen(port,()=>console.log(`Ignifire account service listening on ${port}`));
