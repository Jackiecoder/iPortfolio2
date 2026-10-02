const test = require('node:test');
const assert = require('node:assert/strict');
const {valuation, matchingCall, timestamp} = require('../static/js/option-quotes.js');
const demo = require('../static/js/demo-portfolio.js');
const call = {asset:'MRVL',expiration:'2099-10-30',strike:'280',premium:'13',fees:'1.30',contracts:2,remaining_contracts:1};
const q = {strike:280,bid:10.8,ask:11.2,mid:11,last:55,quote_status:'two_sided'};
const snapshot = () => ({symbol:'MRVL',expiration:'2099-10-30',calls:[q],cache_status:'fresh',fetched_at:new Date().toISOString()});
test('remaining-call estimates allocate opening fees and use Ask/Mid instead of Last',()=>{
    const v=valuation(call,q,snapshot());
    assert.equal(v.askCost,1120);
    assert.equal(v.midCost,1100);
    assert.ok(Math.abs(v.pnl-199.35)<1e-6);
});
test('no estimates for stale, too old, unmatched, expired, completed or adjusted calls',()=>{
    for(const c of [{...call,expiration:'2020-01-01'},{...call,remaining_contracts:0},{...call,adjustment_required:true}]) assert.equal(valuation(c,q,snapshot()),null);
    assert.equal(valuation(call,q,{...snapshot(),cache_status:'stale'}),null);
    assert.equal(valuation(call,q,{...snapshot(),fetched_at:'2020-01-01T12:00:00Z'}),null);
    assert.equal(valuation(call,null,snapshot()),null);
    assert.equal(valuation(call,{...q,quote_status:'crossed',bid:12},snapshot()),null);
});
test('missing bid never uses the old Last price; zero Ask is unavailable',()=>{
    const v=valuation(call,{...q,bid:null,mid:null},snapshot());
    assert.equal(v.pnl,null);assert.equal(v.askCost,1120);
    assert.equal(valuation(call,{...q,bid:0,ask:0,mid:null},snapshot()).askCost,null);
});
test('quotes match exact ticker, expiry and strike',()=>{
    assert.equal(matchingCall(snapshot(),call),q);
    for(const c of [{...call,asset:'MU'},{...call,strike:281},{...call,expiration:'2099-11-06'}]) assert.equal(matchingCall(snapshot(),c),null);
    assert.equal(timestamp(null),'Not supplied');
});
test('public Demo quotes remain synthetic, read-only and separate from Yahoo',async()=>{
    const portfolio=demo.create();
    const r=await portfolio.fetch('/api/options/calls?symbol=MU');const data=await r.json();
    assert.equal(r.status,200);assert.equal(data.source,'Synthetic demo');assert.equal(data.calls.length,5);
    assert.equal((await portfolio.fetch('/api/options/calls?symbol=PRIVATE')).status,404);
    assert.equal((await portfolio.fetch('/api/options/calls?symbol=MU',{method:'POST'})).status,405);
});
