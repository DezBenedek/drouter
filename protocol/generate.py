import json
s = lambda maximum=64: {"type":"string","minLength":1,"maxLength":maximum}
def obj(properties, required=None): return {"type":"object","properties":properties,"required":list(properties) if required is None else required,"additionalProperties":False}
identifier=obj({"id":s(32)})
empty=obj({})
nullable_ip={"anyOf":[{"type":"string","format":"ipv4"},{"type":"null"}]}
eth=obj({k:nullable_ip for k in ["address","mask","gateway","dns"]},[])
policy=obj({"preferred_check_secs":{"type":"integer","minimum":60,"maximum":3600},"retry_secs":{"type":"integer","minimum":5,"maximum":120},"prefer_higher":{"type":"boolean"}})
wifi=obj({"id":s(32),"ssid":s(32),"password":{"type":"string","maxLength":63},"confirm_disconnect": {"type":"boolean"}, "priority":{"type":"integer","minimum":0},"enabled":{"type":"boolean"}},["id","ssid"])
receiver=obj({"id":s(32),"label":s(),"ip":{"type":"string","format":"ipv4"},"port":{"type":"integer","minimum":1,"maximum":65535},"channel":{"type":"integer","minimum":1,"maximum":4}})
settings=obj({"expected_revision":{"type":"integer","minimum":1},"name":s(32),"password":{"type":"string","minLength":4,"maxLength":128},"ethernet":eth,"wifi_policy":policy,"cloud_enabled":{"type":"boolean"},"server":s(256)},["expected_revision"])
operations={op:empty for op in ['device.info','device.health','network.status','wifi.list','receivers.list','receivers.discover','sources.list','sources.refresh','route.get','presets.list','sessions.revoke','factory.reset']}
operations.update({op:identifier for op in ['wifi.remove','wifi.connect','receivers.remove','presets.delete','presets.apply']})
operations.update({'wifi.add':wifi,'wifi.reorder':obj({'ids':{'type':'array','items':s(32),'uniqueItems':True}}),'receivers.add':receiver,'route.set':obj({'receiver':s(32),'source':s(256)}),'presets.create':obj({'name':s()}),'settings.update':settings,'wifi.set_enabled':obj({'id':s(32),'enabled':{'type':'boolean'},'confirm_disconnect':{'type':'boolean'}},['id','enabled']),'identity.export':empty,'identity.restore':obj({'identity':{'type':'string','pattern':'^[a-f0-9]{64}$'},'name':s(32),'password':{'type':'string','minLength':12,'maxLength':128},'expected_revision':{'type':'integer','minimum':1}})})
operations.update({op:obj({'id':s(32),'name':s()}) for op in ['receivers.rename','presets.update']})
operations['wifi.connect']=obj({'id':s(32),'confirm_disconnect':{'type':'boolean'}},['id'])
operations['wifi.remove']=obj({'id':s(32),'confirm_disconnect':{'type':'boolean'}},['id'])
boolean={'type':'boolean'}
change={'confirmed':{'const':True},'expected_revision':{'type':'integer','minimum':1}}
def mutation(properties, required): return obj({**change,**properties},['confirmed','expected_revision',*required])
action=obj({'id':s(32),'label':s(),'icon':{'anyOf':[s(32),{'type':'null'}]},'receiver':s(32),'source':s(256),'enabled':boolean,'order':{'type':'integer','minimum':0}})
actions={'type':'array','minItems':1,'maxItems':10,'items':action}
password={'type':'string','minLength':4,'maxLength':128}
operations.update({op:empty for op in ['sources.saved.list','simple.list','event.status','auth.login','auth.logout','auth.session']})
operations['sources.saved.add']=mutation({'source':s(256),'display_name':s()},['source'])
operations['sources.saved.update']=mutation({'id':s(32),'display_name':s()},['id','display_name'])
operations['sources.saved.remove']=mutation({'id':s(32)},['id'])
order={'ids':{'type':'array','items':s(32),'uniqueItems':True}}
operations['sources.saved.reorder']=mutation(order,['ids'])
profile={'name':s(),'password':password,'description':{'type':'string','maxLength':256},'enabled':boolean,'order':{'type':'integer','minimum':0},'actions':actions}
operations['simple.create']=mutation(profile,['name','password','actions'])
operations['simple.update']=mutation({'id':s(32),**profile},['id'])
operations['simple.delete']=mutation({'id':s(32)},['id'])
operations['simple.actions.list']=obj({'profile_id':s(32)},[])
for op in ['create','update']: operations['simple.actions.'+op]=mutation({'profile_id':s(32),'action':action},['profile_id','action'])
operations['simple.actions.delete']=mutation({'profile_id':s(32),'id':s(32)},['profile_id','id'])
operations['simple.actions.reorder']=mutation({'profile_id':s(32),**order},['profile_id','ids'])
operations['simple.action.execute']=identifier
for op in ['event.enable','event.disable']:operations[op]=mutation({},[])
operations['auth.password.change']=mutation({'password':password},['password'])
requests=[obj({'v':{'const':1},'id':s(),'op':{'const':op},'params':params}) for op,params in operations.items()]
root={'$schema':'http://json-schema.org/draft-07/schema#','$id':'https://drouter.dezso.hu/protocol/v1','title':'DRouter application request','oneOf':requests,'definitions':{'response':obj({'v':{'const':1},'id':s(),'ok':{'type':'boolean'},'result':{},'error':obj({'code':s(),'message':s(512)})},['v','id','ok']),'setup':obj({'name':s(32),'password':{'type':'string','minLength':12,'maxLength':128},'ethernet':eth,'cloud_enabled':{'type':'boolean'},'wifi':{'anyOf':[wifi,{'type':'null'}]},'wifi_profiles':{'type':'array','items':wifi}},['name','password','ethernet','cloud_enabled'])}}
open('protocol/protocol.schema.json','w').write(json.dumps(root,indent=2)+'\n')
open('cloud/src/operations.ts','w').write('export const operations = '+json.dumps(list(operations))+' as const;\n')
