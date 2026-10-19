import json
s = lambda maximum=64: {"type":"string","minLength":1,"maxLength":maximum}
def obj(properties, required=None): return {"type":"object","properties":properties,"required":list(properties) if required is None else required,"additionalProperties":False}
identifier=obj({"id":s(32)})
empty=obj({})
nullable_ip={"anyOf":[{"type":"string","format":"ipv4"},{"type":"null"}]}
eth=obj({k:nullable_ip for k in ["address","mask","gateway","dns"]},[])
policy=obj({"preferred_check_secs":{"type":"integer","minimum":60,"maximum":3600},"retry_secs":{"type":"integer","minimum":5,"maximum":120},"prefer_higher":{"type":"boolean"}})
wifi=obj({"id":s(32),"ssid":s(32),"password":{"type":"string","minLength":8,"maxLength":63}})
receiver=obj({"id":s(32),"label":s(),"ip":{"type":"string","format":"ipv4"},"port":{"type":"integer","minimum":1,"maximum":65535},"channel":{"type":"integer","minimum":1,"maximum":4}})
settings=obj({"expected_revision":{"type":"integer","minimum":1},"name":s(32),"password":{"type":"string","minLength":12,"maxLength":128},"ethernet":eth,"wifi_policy":policy,"cloud_enabled":{"type":"boolean"},"server":s(256)},["expected_revision"])
operations={op:empty for op in ['device.info','device.health','network.status','wifi.list','receivers.list','receivers.discover','sources.list','sources.refresh','route.get','presets.list','sessions.revoke','factory.reset']}
operations.update({op:identifier for op in ['wifi.remove','wifi.connect','receivers.remove','presets.delete','presets.apply']})
operations.update({'wifi.add':wifi,'wifi.reorder':obj({'ids':{'type':'array','items':s(32),'maxItems':8,'uniqueItems':True}}),'receivers.add':receiver,'route.set':obj({'receiver':s(32),'source':s(256)}),'presets.create':obj({'name':s()}),'settings.update':settings})
operations.update({op:obj({'id':s(32),'name':s()}) for op in ['receivers.rename','presets.update']})
requests=[obj({'v':{'const':1},'id':s(),'op':{'const':op},'params':params}) for op,params in operations.items()]
root={'$schema':'http://json-schema.org/draft-07/schema#','$id':'https://drouter.dezso.hu/protocol/v1','title':'DRouter application request','oneOf':requests,'definitions':{'response':obj({'v':{'const':1},'id':s(),'ok':{'type':'boolean'},'result':{},'error':obj({'code':s(),'message':s(512)})},['v','id','ok']),'setup':obj({'token':s(64),'name':s(32),'password':{'type':'string','minLength':12,'maxLength':128},'ethernet':eth,'cloud_enabled':{'type':'boolean'},'wifi':{'anyOf':[wifi,{'type':'null'}]}})}}
open('protocol/protocol.schema.json','w').write(json.dumps(root,indent=2)+'\n')
open('cloud/src/operations.ts','w').write('export const operations = '+json.dumps(list(operations))+' as const;\n')
