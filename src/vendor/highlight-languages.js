/*! Languages added to highlight.min.js (cookapps, A-21): the files languages/{dockerfile,powershell,dos,dart,scala,groovy,elixir,erlang,haskell,clojure,protobuf,cmake,nim,verilog,delphi,fsharp,julia,tcl,coffeescript,handlebars,scheme,twig,pgsql}.min.js of @highlightjs/cdn-assets 11.12.0, joined as they are. Highlight.js, (c) 2006-2026 Josh Goebel and other contributors, License: BSD-3-Clause */
/*! `dockerfile` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>({name:"Dockerfile",aliases:["docker"],
case_insensitive:!0,
keywords:["from","maintainer","expose","env","arg","user","onbuild","stopsignal"],
contains:[e.HASH_COMMENT_MODE,e.APOS_STRING_MODE,e.QUOTE_STRING_MODE,e.NUMBER_MODE,{
beginKeywords:"run cmd entrypoint volume add copy workdir label healthcheck shell",
starts:{end:/[^\\]$/,subLanguage:"bash"}}],illegal:"</"})})()
;hljs.registerLanguage("dockerfile",e)})();
/*! `powershell` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{const n={$pattern:/-?[A-z\.\-]+\b/,
keyword:"if else foreach return do while until elseif begin for trap data dynamicparam end break throw param continue finally in switch exit filter try process catch hidden static parameter",
built_in:"ac asnp cat cd CFS chdir clc clear clhy cli clp cls clv cnsn compare copy cp cpi cpp curl cvpa dbp del diff dir dnsn ebp echo|0 epal epcsv epsn erase etsn exsn fc fhx fl ft fw gal gbp gc gcb gci gcm gcs gdr gerr ghy gi gin gjb gl gm gmo gp gps gpv group gsn gsnp gsv gtz gu gv gwmi h history icm iex ihy ii ipal ipcsv ipmo ipsn irm ise iwmi iwr kill lp ls man md measure mi mount move mp mv nal ndr ni nmo npssc nsn nv ogv oh popd ps pushd pwd r rbp rcjb rcsn rd rdr ren ri rjb rm rmdir rmo rni rnp rp rsn rsnp rujb rv rvpa rwmi sajb sal saps sasv sbp sc scb select set shcm si sl sleep sls sort sp spjb spps spsv start stz sujb sv swmi tee trcm type wget where wjb write"
},s={begin:"`[\\s\\S]",relevance:0},i={className:"variable",variants:[{
begin:/\$\B/},{className:"keyword",begin:/\$this/},{begin:/\$[\w\d][\w\d_:]*/}]
},a={className:"string",variants:[{begin:/"/,end:/"/},{begin:/@"/,end:/^"@/}],
contains:[s,i,{className:"variable",begin:/\$[A-z]/,end:/[^A-z]/}]},t={
className:"string",variants:[{begin:/'/,end:/'/},{begin:/@'/,end:/^'@/}]
},r=e.inherit(e.COMMENT(null,null),{variants:[{begin:/#/,end:/$/},{begin:/<#/,
end:/#>/}],contains:[{className:"doctag",variants:[{
begin:/\.(synopsis|description|example|inputs|outputs|notes|link|component|role|functionality)/
},{
begin:/\.(parameter|forwardhelptargetname|forwardhelpcategory|remotehelprunspace|externalhelp)\s+\S+/
}]}]}),c={className:"class",beginKeywords:"class enum",end:/\s*[{]/,
excludeEnd:!0,relevance:0,contains:[e.TITLE_MODE]},l={className:"function",
begin:/function\s+/,end:/\s*\{|$/,excludeEnd:!0,returnBegin:!0,relevance:0,
contains:[{begin:"function",relevance:0,className:"keyword"},{className:"title",
begin:/\w[\w\d]*((-)[\w\d]+)*/,relevance:0},{begin:/\(/,end:/\)/,
className:"params",relevance:0,contains:[i]}]},o={begin:/using\s/,end:/$/,
returnBegin:!0,contains:[a,t,{className:"keyword",
begin:/(using|assembly|command|module|namespace|type)/}]},p={
className:"function",begin:/\[.*\]\s*[\w]+[ ]??\(/,end:/$/,returnBegin:!0,
relevance:0,contains:[{className:"keyword",
begin:"(".concat(n.keyword.toString().replace(/\s/g,"|"),")\\b"),endsParent:!0,
relevance:0},e.inherit(e.TITLE_MODE,{endsParent:!0})]
},g=[p,r,s,e.NUMBER_MODE,a,t,{className:"built_in",variants:[{
begin:"(Add|Clear|Close|Copy|Enter|Exit|Find|Format|Get|Hide|Join|Lock|Move|New|Open|Optimize|Pop|Push|Redo|Remove|Rename|Reset|Resize|Search|Select|Set|Show|Skip|Split|Step|Switch|Undo|Unlock|Watch|Backup|Checkpoint|Compare|Compress|Convert|ConvertFrom|ConvertTo|Dismount|Edit|Expand|Export|Group|Import|Initialize|Limit|Merge|Mount|Out|Publish|Restore|Save|Sync|Unpublish|Update|Approve|Assert|Build|Complete|Confirm|Deny|Deploy|Disable|Enable|Install|Invoke|Register|Request|Restart|Resume|Start|Stop|Submit|Suspend|Uninstall|Unregister|Wait|Debug|Measure|Ping|Repair|Resolve|Test|Trace|Connect|Disconnect|Read|Receive|Send|Write|Block|Grant|Protect|Revoke|Unblock|Unprotect|Use|ForEach|Sort|Tee|Where)+(-)[\\w\\d]+"
}]},i,{className:"literal",begin:/\$(null|true|false)\b/},{
className:"selector-tag",begin:/@\B/,relevance:0}],m={begin:/\[/,end:/\]/,
excludeBegin:!0,excludeEnd:!0,relevance:0,contains:[].concat("self",g,{
begin:"(string|char|byte|int|long|bool|decimal|single|double|DateTime|xml|array|hashtable|void)",
className:"built_in",relevance:0},{className:"type",begin:/[\.\w\d]+/,
relevance:0})};return p.contains.unshift(m),{name:"PowerShell",
aliases:["pwsh","ps","ps1"],case_insensitive:!0,keywords:n,
contains:g.concat(c,l,o,{variants:[{className:"operator",
begin:"(-and|-as|-band|-bnot|-bor|-bxor|-casesensitive|-ccontains|-ceq|-cge|-cgt|-cle|-clike|-clt|-cmatch|-cne|-cnotcontains|-cnotlike|-cnotmatch|-contains|-creplace|-csplit|-eq|-exact|-f|-file|-ge|-gt|-icontains|-ieq|-ige|-igt|-ile|-ilike|-ilt|-imatch|-in|-ine|-inotcontains|-inotlike|-inotmatch|-ireplace|-is|-isnot|-isplit|-join|-le|-like|-lt|-match|-ne|-not|-notcontains|-notin|-notlike|-notmatch|-or|-regex|-replace|-shl|-shr|-split|-wildcard|-xor)\\b"
},{className:"literal",begin:/(-){1,2}[\w\d-]+/,relevance:0}]},m)}}})()
;hljs.registerLanguage("powershell",e)})();
/*! `dos` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{const t=e.COMMENT(/^\s*@?rem\b/,/$/,{
relevance:10});return{name:"Batch file (DOS)",aliases:["bat","batch","cmd"],
case_insensitive:!0,illegal:/\/\*/,keywords:{
keyword:["if","else","goto","for","in","do","call","exit","not","exist","errorlevel","defined","equ","neq","lss","leq","gtr","geq"],
built_in:["prn","nul","lpt3","lpt2","lpt1","con","com4","com3","com2","com1","aux","shift","cd","dir","echo","setlocal","endlocal","set","pause","copy","append","assoc","at","attrib","break","cacls","cd","chcp","chdir","chkdsk","chkntfs","cls","cmd","color","comp","compact","convert","date","dir","diskcomp","diskcopy","doskey","erase","fs","find","findstr","format","ftype","graftabl","help","keyb","label","md","mkdir","mode","more","move","path","pause","print","popd","pushd","promt","rd","recover","rem","rename","replace","restore","rmdir","shift","sort","start","subst","time","title","tree","type","ver","verify","vol","ping","net","ipconfig","taskkill","xcopy","ren","del"]
},contains:[{className:"variable",begin:/%%[^ ]|%[^ ]+?%|![^ ]+?!/},{
className:"function",begin:"^\\s*[A-Za-z._?][A-Za-z0-9_$#@~.?]*(:|\\s+label)",
end:"goto:eof",contains:[e.inherit(e.TITLE_MODE,{
begin:"([_a-zA-Z]\\w*\\.)*([_a-zA-Z]\\w*:)?[_a-zA-Z]\\w*"}),t]},{
className:"number",begin:"\\b\\d+",relevance:0},t]}}})()
;hljs.registerLanguage("dos",e)})();
/*! `dart` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{const n=e.regex,a={className:"subst",
variants:[{begin:"\\$[A-Za-z0-9_]+"}]},t={className:"subst",variants:[{
begin:/\$\{/,end:/\}/}],keywords:"true false null this is new super"},i={
className:"number",relevance:0,variants:[{
match:/\b[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9][0-9_]*)?\b/},{
match:/\b0[xX][0-9A-Fa-f][0-9A-Fa-f_]*\b/}]},s={className:"string",variants:[{
begin:"r'''",end:"'''"},{begin:'r"""',end:'"""'},{begin:"r'",end:"'",
illegal:"\\n"},{begin:'r"',end:'"',illegal:"\\n"},{begin:"'''",end:"'''",
contains:[e.BACKSLASH_ESCAPE,a,t]},{begin:'"""',end:'"""',
contains:[e.BACKSLASH_ESCAPE,a,t]},{begin:"'",end:"'",illegal:"\\n",
contains:[e.BACKSLASH_ESCAPE,a,t]},{begin:'"',end:'"',illegal:"\\n",
contains:[e.BACKSLASH_ESCAPE,a,t]}]};t.contains=[i,s]
;const r=["Comparable","DateTime","Duration","Function","Iterable","Iterator","List","Map","Match","Object","Pattern","RegExp","Set","Stopwatch","String","StringBuffer","StringSink","Symbol","Type","Uri","bool","double","int","num","Element","ElementList"],c=r.map(e=>e+"?"),l={
keyword:["abstract","as","assert","async","await","base","break","case","catch","class","const","continue","covariant","default","deferred","do","dynamic","else","enum","export","extends","extension","external","factory","false","final","finally","for","Function","get","hide","if","implements","import","in","interface","is","late","library","mixin","new","null","on","operator","part","required","rethrow","return","sealed","set","show","static","super","switch","sync","this","throw","true","try","typedef","var","void","when","while","with","yield"],
built_in:r.concat(c).concat(["Never","Null","dynamic","print","document","querySelector","querySelectorAll","window"]),
$pattern:/[A-Za-z][A-Za-z0-9_]*\??/},o={
match:n.concat(/\b_?/,n.either(/(?:[A-Z]+[a-z0-9]+)+/,/(?:[A-Z]+[a-z0-9]+)+[A-Z]+/),/(?![A-Za-z0-9_])/),
scope:"title.class"};return{name:"Dart",keywords:l,
contains:[s,e.COMMENT(/\/\*\*(?!\/)/,/\*\//,{subLanguage:"markdown",relevance:0
}),e.COMMENT(/\/{3,} ?/,/$/,{contains:[{subLanguage:"markdown",begin:".",
end:"$",relevance:0}]}),e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,{
className:"class",beginKeywords:"class interface",end:/\{/,excludeEnd:!0,
contains:[{beginKeywords:"extends implements"},e.UNDERSCORE_TITLE_MODE]},o,{
match:/\b(?!(?:assert|catch|for|if|switch|while)\b)[a-z_][A-Za-z0-9_]*(?=\()/,
scope:"title.function"},i,{className:"meta",begin:"@[A-Za-z]+"}]}}})()
;hljs.registerLanguage("dart",e)})();
/*! `scala` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{const n=e.regex,a={className:"subst",
variants:[{begin:"\\$[A-Za-z0-9_]+"},{begin:/\$\{/,end:/\}/}]},s={
className:"string",variants:[{begin:'"""',end:'"""'},{begin:'"',end:'"',
illegal:"\\n",contains:[e.BACKSLASH_ESCAPE]},{begin:'[a-z]+"',end:'"',
illegal:"\\n",contains:[e.BACKSLASH_ESCAPE,a]},{className:"string",
begin:'[a-z]+"""',end:'"""',contains:[a],relevance:10}]},i={className:"type",
begin:"\\b[A-Z][A-Za-z0-9_]*",relevance:0},t={className:"title",
begin:/[^0-9\n\t "'(),.`{}\[\]:;][^\n\t "'(),.`{}\[\]:;]+|[^0-9\n\t "'(),.`{}\[\]:;=]/,
relevance:0},c={className:"class",beginKeywords:"class object trait type",
end:/[:={\[\n;]/,excludeEnd:!0,
contains:[e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,{
beginKeywords:"extends with",relevance:10},{begin:/\[/,end:/\]/,excludeBegin:!0,
excludeEnd:!0,relevance:0,
contains:[i,e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE]},{className:"params",
begin:/\(/,end:/\)/,excludeBegin:!0,excludeEnd:!0,relevance:0,
contains:[i,e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE]},t]},r={
className:"function",beginKeywords:"def",end:n.lookahead(/[:={\[(\n;]/),
contains:[t]};return{name:"Scala",keywords:{literal:"true false null",
keyword:"type yield lazy override def with val var sealed abstract private trait object if then forSome for while do throw finally protected extends import final return else break new catch super class case package default try this match continue throws implicit export enum given transparent"
},contains:[{begin:["//>",/\s+/,/using/,/\s+/,/\S+/],beginScope:{1:"comment",
3:"keyword",5:"type"},end:/$/,contains:[{className:"string",begin:/\S+/}]
},e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,s,i,r,c,e.C_NUMBER_MODE,{
begin:[/^\s*/,"extension",/\s+(?=[[(])/],beginScope:{2:"keyword"}},{
begin:[/^\s*/,/end/,/\s+/,/(extension\b)?/],beginScope:{2:"keyword",4:"keyword"}
},{match:/\.inline\b/},{begin:/\binline(?=\s)/,keywords:"inline"},{
begin:[/\(\s*/,/using/,/\s+(?!\))/],beginScope:{2:"keyword"}},{className:"meta",
begin:"@[A-Za-z]+"}]}}})();hljs.registerLanguage("scala",e)})();
/*! `groovy` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict"
;var e="[0-9](_*[0-9])*",a=`\\.(${e})`,n="[0-9a-fA-F](_*[0-9a-fA-F])*",t={
className:"number",variants:[{
begin:`(\\b(${e})((${a})|\\.)?|(${a}))[eE][+-]?(${e})[fFdD]?\\b`},{
begin:`\\b(${e})((${a})[fFdD]?\\b|\\.([fFdD]\\b)?)`},{begin:`(${a})[fFdD]?\\b`
},{begin:`\\b(${e})[fFdD]\\b`},{
begin:`\\b0[xX]((${n})\\.?|(${n})?\\.(${n}))[pP][+-]?(${e})[fFdD]?\\b`},{
begin:"\\b(0|[1-9](_*[0-9])*)[lL]?\\b"},{begin:`\\b0[xX](${n})[lL]?\\b`},{
begin:"\\b0(_*[0-7])*[lL]?\\b"},{begin:"\\b0[bB][01](_*[01])*[lL]?\\b"}],
relevance:0};function r(e,a={}){return a.variants=e,a}return e=>{
const a=e.regex,n="[A-Za-z0-9_$]+",i=r([e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,e.COMMENT("/\\*\\*","\\*/",{
relevance:0,contains:[{begin:/\w+@/,relevance:0},{className:"doctag",
begin:"@[A-Za-z]+"}]})]),s={className:"regexp",begin:/~?\/[^\/\n]+\//,
contains:[e.BACKSLASH_ESCAPE]},l=t,b=r([{begin:/"""/,end:/"""/},{begin:/'''/,
end:/'''/},{begin:"\\$/",end:"/\\$",relevance:10
},e.APOS_STRING_MODE,e.QUOTE_STRING_MODE],{className:"string"}),c={
match:[/(class|interface|trait|enum|record|extends|implements)/,/\s+/,e.UNDERSCORE_IDENT_RE],
scope:{1:"keyword",3:"title.class"}};return{name:"Groovy",keywords:{
"variable.language":"this super",literal:"true false null",
type:["byte","short","char","int","long","boolean","float","double","void"],
keyword:["def","as","in","assert","trait","abstract","static","volatile","transient","public","private","protected","synchronized","final","class","interface","enum","if","else","for","while","switch","case","break","default","continue","throw","throws","try","catch","finally","implements","extends","new","import","package","return","instanceof","var"]
},contains:[e.SHEBANG({binary:"groovy",relevance:10}),i,b,s,l,c,{
className:"meta",begin:"@[A-Za-z]+",relevance:0},{className:"attr",
begin:n+"[ \t]*:",relevance:0},{begin:/\?/,end:/:/,relevance:0,
contains:[i,b,s,l,"self"]},{className:"symbol",
begin:"^[ \t]*"+a.lookahead(n+":"),excludeBegin:!0,end:n+":",relevance:0}],
illegal:/#|<\//}}})();hljs.registerLanguage("groovy",e)})();
/*! `elixir` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{
const n=e.regex,a="[a-zA-Z_][a-zA-Z0-9_.]*(!|\\?)?",i={$pattern:a,
keyword:["after","alias","and","case","catch","cond","defstruct","defguard","defguardp","do","else","end","fn","for","if","import","in","not","or","quote","raise","receive","require","reraise","rescue","try","unless","unquote","unquote_splicing","use","when","with|0"],
literal:["false","nil","true"]},s={className:"subst",begin:/#\{/,end:/\}/,
keywords:i},c={match:/\\[\s\S]/,scope:"char.escape",relevance:0
},r="[/|([{<\"']",t=[{begin:/"/,end:/"/},{begin:/'/,end:/'/},{begin:/\//,
end:/\//},{begin:/\|/,end:/\|/},{begin:/\(/,end:/\)/},{begin:/\[/,end:/\]/},{
begin:/\{/,end:/\}/},{begin:/</,end:/>/}],d=e=>({scope:"char.escape",
begin:n.concat(/\\/,e),relevance:0}),o={className:"string",
begin:"~[a-z](?="+r+")",contains:t.map(n=>e.inherit(n,{contains:[d(n.end),c,s]
}))},b={className:"string",begin:"~[A-Z](?="+r+")",
contains:t.map(n=>e.inherit(n,{contains:[d(n.end)]}))},g={className:"regex",
variants:[{begin:"~r(?="+r+")",contains:t.map(a=>e.inherit(a,{
end:n.concat(a.end,/[uismxfU]{0,7}/),contains:[d(a.end),c,s]}))},{
begin:"~R(?="+r+")",contains:t.map(a=>e.inherit(a,{
end:n.concat(a.end,/[uismxfU]{0,7}/),contains:[d(a.end)]}))}]},l={
className:"string",contains:[e.BACKSLASH_ESCAPE,s],variants:[{begin:/"""/,
end:/"""/},{begin:/'''/,end:/'''/},{begin:/~S"""/,end:/"""/,contains:[]},{
begin:/~S"/,end:/"/,contains:[]},{begin:/~S'''/,end:/'''/,contains:[]},{
begin:/~S'/,end:/'/,contains:[]},{begin:/'/,end:/'/},{begin:/"/,end:/"/}]},m={
className:"function",beginKeywords:"def defp defmacro defmacrop",end:/\B\b/,
contains:[e.inherit(e.TITLE_MODE,{begin:a,endsParent:!0})]},u=e.inherit(m,{
className:"class",beginKeywords:"defimpl defmodule defprotocol defrecord",
end:/\bdo\b|$|;/}),f=[{scope:"string",match:/\?'/,relevance:0
},l,g,b,o,e.HASH_COMMENT_MODE,u,m,{begin:"::"},{className:"symbol",
begin:":(?![\\s:])",contains:[l,{
begin:"[a-zA-Z_]\\w*[!?=]?|[-+~]@|<<|>>|=~|===?|<=>|[<>]=?|\\*\\*|[-/+%^&*~`|]|\\[\\]=?"
}],relevance:0},{className:"symbol",begin:a+":(?!:)",relevance:0},{
className:"title.class",begin:/(\b[A-Z][a-zA-Z0-9_]+)/,relevance:0},{
className:"number",
begin:"(\\b0o[0-7_]+)|(\\b0b[01_]+)|(\\b0x[0-9a-fA-F_]+)|(-?\\b[0-9][0-9_]*(\\.[0-9_]+([eE][-+]?[0-9]+)?)?)",
relevance:0},{className:"variable",begin:"(\\$\\W)|((\\$|@@?)(\\w+))"}]
;return s.contains=f,{name:"Elixir",aliases:["ex","exs"],keywords:i,contains:f}}
})();hljs.registerLanguage("elixir",e)})();
/*! `erlang` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{
const n="[a-z'][a-zA-Z0-9_']*",i="("+n+":"+n+"|"+n+")",a={
keyword:"after and andalso|10 band begin bnot bor bsl bzr bxor case catch cond div end fun if let not of orelse|10 query receive rem try when xor maybe else",
literal:"false true"},r=e.COMMENT("%","$"),s={className:"number",
begin:"\\b(\\d+(_\\d+)*#[a-fA-F0-9]+(_[a-fA-F0-9]+)*|\\d+(_\\d+)*(\\.\\d+(_\\d+)*)?([eE][-+]?\\d+)?)",
relevance:0},d={begin:"fun\\s+"+n+"/\\d+"},c={begin:i+"\\(",end:"\\)",
returnBegin:!0,relevance:0,contains:[{begin:i,relevance:0},{begin:"\\(",
end:"\\)",endsWithParent:!0,returnEnd:!0,relevance:0}]},t={begin:/\{/,end:/\}/,
relevance:0},o={begin:"\\b_([A-Z][A-Za-z0-9_]*)?",relevance:0},l={
begin:"[A-Z][a-zA-Z0-9_]*",relevance:0},g={begin:"#"+e.UNDERSCORE_IDENT_RE,
relevance:0,returnBegin:!0,contains:[{begin:"#"+e.UNDERSCORE_IDENT_RE,
relevance:0},{begin:/\{/,end:/\}/,relevance:0}]},b={scope:"string",
match:/\$(\\([^0-9]|[0-9]{1,3}|)|.)/},E={scope:"string",
match:/"""("*)(?!")[\s\S]*?"""\1/},_={scope:"string",
contains:[e.BACKSLASH_ESCAPE],variants:[{match:/~\w?"""("*)(?!")[\s\S]*?"""\1/
},{begin:/~\w?\(/,end:/\)/},{begin:/~\w?\[/,end:/\]/},{begin:/~\w?{/,end:/}/},{
begin:/~\w?</,end:/>/},{begin:/~\w?\//,end:/\//},{begin:/~\w?\|/,end:/\|/},{
begin:/~\w?'/,end:/'/},{begin:/~\w?"/,end:/"/},{begin:/~\w?`/,end:/`/},{
begin:/~\w?#/,end:/#/}]},u={beginKeywords:"fun receive if try case maybe",
end:"end",keywords:a};u.contains=[r,d,e.inherit(e.APOS_STRING_MODE,{className:""
}),u,c,_,E,e.QUOTE_STRING_MODE,s,t,o,l,g,b]
;const f=[r,d,u,c,_,E,e.QUOTE_STRING_MODE,s,t,o,l,g,b];c.contains[1].contains=f,
t.contains=f,g.contains[1].contains=f;const v={className:"params",begin:"\\(",
end:"\\)",contains:f};return{name:"Erlang",aliases:["erl"],keywords:a,
illegal:"(</|\\*=|\\+=|-=|/\\*|\\*/|\\(\\*|\\*\\))",contains:[{
className:"function",begin:"^"+n+"\\s*\\(",end:"->",returnBegin:!0,
illegal:"\\(|#|//|/\\*|\\\\|:|;",contains:[v,e.inherit(e.TITLE_MODE,{begin:n})],
starts:{end:";|\\.",keywords:a,contains:f}},r,{begin:"^-",end:"\\.",relevance:0,
excludeEnd:!0,returnBegin:!0,keywords:{$pattern:"-"+e.IDENT_RE,
keyword:["-module","-record","-undef","-export","-ifdef","-ifndef","-author","-copyright","-doc","-moduledoc","-vsn","-import","-include","-include_lib","-compile","-define","-else","-endif","-file","-behaviour","-behavior","-spec","-on_load","-nifs"].map(e=>e+"|1.5").join(" ")
},contains:[v,_,E,e.QUOTE_STRING_MODE]},s,_,E,e.QUOTE_STRING_MODE,g,o,l,t,b,{
begin:/\.$/}]}}})();hljs.registerLanguage("erlang",e)})();
/*! `haskell` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{
const n="([0-9]_*)+",a="([0-9a-fA-F]_*)+",i="([!#$%&*+.\\/<=>?@\\\\^~-]|(?!([(),;\\[\\]`|{}]|[_:\"']))(\\p{S}|\\p{P}))",s={
variants:[e.COMMENT("--+","$"),e.COMMENT(/\{-/,/-\}/,{contains:["self"]})]},l={
className:"meta",begin:/\{-#/,end:/#-\}/},t={className:"meta",begin:"^#",end:"$"
},c={className:"type",begin:"\\b[A-Z][\\w']*",relevance:0},r={begin:"\\(",
end:"\\)",illegal:'"',contains:[l,t,{className:"type",
begin:"\\b[A-Z][\\w]*(\\((\\.\\.|,|\\w+)\\))?"},e.inherit(e.TITLE_MODE,{
begin:"[_a-z][\\w']*"}),s]},o={className:"number",relevance:0,variants:[{
match:`\\b(${n})(\\.(${n}))?([eE][+-]?(${n}))?\\b`},{
match:`\\b0[xX]_*(${a})(\\.(${a}))?([pP][+-]?(${n}))?\\b`},{
match:"\\b0[oO](([0-7]_*)+)\\b"},{match:"\\b0[bB](([01]_*)+)\\b"}]};return{
name:"Haskell",aliases:["hs"],
keywords:"let in if then else case of where do module import hiding qualified type data newtype deriving class instance as default infix infixl infixr foreign export ccall stdcall cplusplus jvm dotnet safe unsafe family forall mdo proc rec",
unicodeRegex:!0,contains:[{beginKeywords:"module",end:"where",
keywords:"module where",contains:[r,s],illegal:"\\W\\.|;"},{
begin:"\\bimport\\b",end:"$",keywords:"import qualified as hiding",
contains:[r,s],illegal:"\\W\\.|;"},{className:"class",
begin:"^(\\s*)?(class|instance)\\b",end:"where",
keywords:"class family instance where",contains:[c,r,s]},{className:"class",
begin:"\\b(data|(new)?type)\\b",end:"$",
keywords:"data family type newtype deriving where",contains:[l,c,r,{begin:/\{/,
end:/\}/,contains:r.contains},s]},{beginKeywords:"default",end:"$",
contains:[c,r,s]},{beginKeywords:"infix infixl infixr",end:"$",
contains:[e.C_NUMBER_MODE,s]},{begin:"\\bforeign\\b",end:"$",
keywords:"foreign import export ccall stdcall cplusplus jvm dotnet safe unsafe",
contains:[c,e.QUOTE_STRING_MODE,s]},{className:"meta",
begin:"#!\\/usr\\/bin\\/env runhaskell",end:"$"},l,t,{scope:"string",
begin:/'(?=\\?.')/,end:/'/,contains:[{scope:"char.escape",match:/\\./}]
},e.QUOTE_STRING_MODE,o,c,e.inherit(e.TITLE_MODE,{begin:"^[_a-z][\\w']*"}),{
begin:`(?!-)${i}--+|--+(?!-)${i}`},s,{begin:"->|<-"}]}}})()
;hljs.registerLanguage("haskell",e)})();
/*! `clojure` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{
const t="a-zA-Z_\\-!.?+*=<>&'",n="[#]?["+t+"]["+t+"0-9/;:$#]*",a="def defonce defprotocol defstruct defmulti defmethod defn- defn defmacro deftype defrecord",r={
$pattern:n,
built_in:a+" cond apply if-not if-let if not not= =|0 <|0 >|0 <=|0 >=|0 ==|0 +|0 /|0 *|0 -|0 rem quot neg? pos? delay? symbol? keyword? true? false? integer? empty? coll? list? set? ifn? fn? associative? sequential? sorted? counted? reversible? number? decimal? class? distinct? isa? float? rational? reduced? ratio? odd? even? char? seq? vector? string? map? nil? contains? zero? instance? not-every? not-any? libspec? -> ->> .. . inc compare do dotimes mapcat take remove take-while drop letfn drop-last take-last drop-while while intern condp case reduced cycle split-at split-with repeat replicate iterate range merge zipmap declare line-seq sort comparator sort-by dorun doall nthnext nthrest partition eval doseq await await-for let agent atom send send-off release-pending-sends add-watch mapv filterv remove-watch agent-error restart-agent set-error-handler error-handler set-error-mode! error-mode shutdown-agents quote var fn loop recur throw try monitor-enter monitor-exit macroexpand macroexpand-1 for dosync and or when when-not when-let comp juxt partial sequence memoize constantly complement identity assert peek pop doto proxy first rest cons cast coll last butlast sigs reify second ffirst fnext nfirst nnext meta with-meta ns in-ns create-ns import refer keys select-keys vals key val rseq name namespace promise into transient persistent! conj! assoc! dissoc! pop! disj! use class type num float double short byte boolean bigint biginteger bigdec print-method print-dup throw-if printf format load compile get-in update-in pr pr-on newline flush read slurp read-line subvec with-open memfn time re-find re-groups rand-int rand mod locking assert-valid-fdecl alias resolve ref deref refset swap! reset! set-validator! compare-and-set! alter-meta! reset-meta! commute get-validator alter ref-set ref-history-count ref-min-history ref-max-history ensure sync io! new next conj set! to-array future future-call into-array aset gen-class reduce map filter find empty hash-map hash-set sorted-map sorted-map-by sorted-set sorted-set-by vec vector seq flatten reverse assoc dissoc list disj get union difference intersection extend extend-type extend-protocol int nth delay count concat chunk chunk-buffer chunk-append chunk-first chunk-rest max min dec unchecked-inc-int unchecked-inc unchecked-dec-inc unchecked-dec unchecked-negate unchecked-add-int unchecked-add unchecked-subtract-int unchecked-subtract chunk-next chunk-cons chunked-seq? prn vary-meta lazy-seq spread list* str find-keyword keyword symbol gensym force rationalize"
},s={begin:n,relevance:0},o={scope:"number",relevance:0,variants:[{
match:/[-+]?0[xX][0-9a-fA-F]+N?/},{match:/[-+]?0[0-7]+N?/},{
match:/[-+]?[1-9][0-9]?[rR][0-9a-zA-Z]+N?/},{match:/[-+]?[0-9]+\/[0-9]+N?/},{
match:/[-+]?[0-9]+((\.[0-9]*([eE][+-]?[0-9]+)?M?)|([eE][+-]?[0-9]+M?|M))/},{
match:/[-+]?([1-9][0-9]*|0)N?/}]},c={scope:"character",variants:[{
match:/\\o[0-3]?[0-7]{1,2}/},{match:/\\u[0-9a-fA-F]{4}/},{
match:/\\(newline|space|tab|formfeed|backspace|return)/},{match:/\\\S/,
relevance:0}]},i={scope:"regex",begin:/#"/,end:/"/,contains:[e.BACKSLASH_ESCAPE]
},d=e.inherit(e.QUOTE_STRING_MODE,{illegal:null}),l={scope:"punctuation",
match:/,/,relevance:0},m=e.COMMENT(";","$",{relevance:0}),p={
className:"literal",begin:/\b(true|false|nil)\b/},u={
begin:"\\[|(#::?"+n+")?\\{",end:"[\\]\\}]",relevance:0},f={className:"symbol",
begin:"[:]{1,2}"+n},h={begin:"\\(",end:"\\)"},y={endsWithParent:!0,relevance:0
},g={keywords:r,className:"name",begin:n,relevance:0,starts:y
},b=[l,h,c,i,d,m,f,u,o,p,s],v={beginKeywords:a,keywords:{$pattern:n,keyword:a},
end:'(\\[|#|\\d|"|:|\\{|\\)|\\(|$)',contains:[{className:"title",begin:n,
relevance:0,excludeEnd:!0,endsParent:!0}].concat(b)}
;return h.contains=[v,g,y],y.contains=b,u.contains=b,{name:"Clojure",
aliases:["clj","edn"],illegal:/\S/,contains:[l,h,c,i,d,m,f,u,o,p]}}})()
;hljs.registerLanguage("clojure",e)})();
/*! `protobuf` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{const s={
match:[/(message|enum|service)\s+/,e.IDENT_RE],scope:{1:"keyword",
2:"title.class"}};return{name:"Protocol Buffers",aliases:["proto"],keywords:{
keyword:["package","import","option","optional","required","repeated","group","oneof"],
type:["double","float","int32","int64","uint32","uint64","sint32","sint64","fixed32","fixed64","sfixed32","sfixed64","bool","string","bytes"],
literal:["true","false"]},
contains:[e.QUOTE_STRING_MODE,e.NUMBER_MODE,e.C_LINE_COMMENT_MODE,e.C_BLOCK_COMMENT_MODE,s,{
className:"function",beginKeywords:"rpc",end:/[{;]/,excludeEnd:!0,
keywords:"rpc returns"},{begin:/^\s*[A-Z_]+(?=\s*=[^\n]+;$)/}]}}})()
;hljs.registerLanguage("protobuf",e)})();
/*! `cmake` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>({name:"CMake",aliases:["cmake.in"],
case_insensitive:!0,keywords:{
keyword:"block break cmake_host_system_information cmake_minimum_required cmake_parse_arguments cmake_policy configure_file continue elseif else endblock endforeach endfunction endif endmacro endwhile execute_process file find_file find_library find_package find_path find_program foreach function get_cmake_property get_directory_property get_filename_component get_property if include include_guard list macro mark_as_advanced math message option return separate_arguments set_directory_properties set_property set site_name string unset variable_watch while add_compile_definitions add_compile_options add_custom_command add_custom_target add_definitions add_dependencies add_executable add_library add_link_options add_subdirectory add_test aux_source_directory build_command create_test_sourcelist define_property enable_language enable_testing export fltk_wrap_ui get_source_file_property get_target_property get_test_property include_directories include_external_msproject include_regular_expression install link_directories link_libraries load_cache project qt_wrap_cpp qt_wrap_ui remove_definitions set_source_files_properties set_target_properties set_tests_properties source_group target_compile_definitions target_compile_features target_compile_options target_include_directories target_link_directories target_link_libraries target_link_options target_sources try_compile try_run ctest_build ctest_configure ctest_coverage ctest_empty_binary_directory ctest_memcheck ctest_read_custom_files ctest_run_script ctest_sleep ctest_start ctest_submit ctest_test ctest_update ctest_upload build_name exec_program export_library_dependencies install_files install_programs install_targets load_command make_directory output_required_files remove subdir_depends subdirs use_mangled_mesa utility_source variable_requires write_file qt5_use_modules qt5_use_package qt5_wrap_cpp on off true false and or not command policy target test exists is_newer_than is_directory is_symlink is_absolute matches less greater equal less_equal greater_equal strless strgreater strequal strless_equal strgreater_equal version_less version_greater version_equal version_less_equal version_greater_equal in_list defined"
},contains:[{className:"variable",begin:/\$\{/,end:/\}/
},e.COMMENT(/#\[\[/,/]]/),e.HASH_COMMENT_MODE,e.QUOTE_STRING_MODE,{
scope:"number",begin:/\b\d+(\.\d+)?\b/,relevance:0}]})})()
;hljs.registerLanguage("cmake",e)})();
/*! `nim` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>({name:"Nim",keywords:{
keyword:["addr","and","as","asm","bind","block","break","case","cast","concept","const","continue","converter","defer","discard","distinct","div","do","elif","else","end","enum","except","export","finally","for","from","func","generic","guarded","if","import","in","include","interface","is","isnot","iterator","let","macro","method","mixin","mod","nil","not","notin","object","of","or","out","proc","ptr","raise","ref","return","shared","shl","shr","static","template","try","tuple","type","using","var","when","while","with","without","xor","yield"],
literal:["true","false"],
type:["int","int8","int16","int32","int64","uint","uint8","uint16","uint32","uint64","float","float32","float64","bool","char","string","cstring","pointer","expr","stmt","void","auto","any","range","array","openarray","varargs","seq","set","clong","culong","cchar","cschar","cshort","cint","csize","clonglong","cfloat","cdouble","clongdouble","cuchar","cushort","cuint","culonglong","cstringarray","semistatic"],
built_in:["stdin","stdout","stderr","result"]},contains:[{className:"meta",
begin:/\{\./,end:/\.\}/,relevance:10},{className:"string",begin:/[a-zA-Z]\w*"/,
end:/"/,contains:[{begin:/""/}]},{className:"string",begin:/([a-zA-Z]\w*)?"""/,
end:/"""/},e.QUOTE_STRING_MODE,{className:"type",begin:/\b[A-Z]\w+\b/,
relevance:0},{className:"number",relevance:0,variants:[{
begin:/\b(0[xX][0-9a-fA-F][_0-9a-fA-F]*)('?[iIuU](8|16|32|64))?/},{
begin:/\b(0o[0-7][_0-7]*)('?[iIuUfF](8|16|32|64))?/},{
begin:/\b(0(b|B)[01][_01]*)('?[iIuUfF](8|16|32|64))?/},{
begin:/\b(\d[_\d]*)('?[iIuUfF](8|16|32|64))?/}]},e.HASH_COMMENT_MODE]})})()
;hljs.registerLanguage("nim",e)})();
/*! `verilog` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{
const n=e.regex,t=["begin_keywords","celldefine","default_nettype","default_decay_time","default_trireg_strength","define","delay_mode_distributed","delay_mode_path","delay_mode_unit","delay_mode_zero","else","elsif","end_keywords","endcelldefine","endif","ifdef","ifndef","include","line","nounconnected_drive","pragma","resetall","timescale","unconnected_drive","undef","undefineall"]
;return{name:"Verilog",aliases:["v","sv","svh"],case_insensitive:!1,keywords:{
$pattern:/\$?[\w]+(\$[\w]+)*/,
keyword:["accept_on","alias","always","always_comb","always_ff","always_latch","and","assert","assign","assume","automatic","before","begin","bind","bins","binsof","bit","break","buf|0","bufif0","bufif1","byte","case","casex","casez","cell","chandle","checker","class","clocking","cmos","config","const","constraint","context","continue","cover","covergroup","coverpoint","cross","deassign","default","defparam","design","disable","dist","do","edge","else","end","endcase","endchecker","endclass","endclocking","endconfig","endfunction","endgenerate","endgroup","endinterface","endmodule","endpackage","endprimitive","endprogram","endproperty","endspecify","endsequence","endtable","endtask","enum","event","eventually","expect","export","extends","extern","final","first_match","for","force","foreach","forever","fork","forkjoin","function","generate|5","genvar","global","highz0","highz1","if","iff","ifnone","ignore_bins","illegal_bins","implements","implies","import","incdir","include","initial","inout","input","inside","instance","int","integer","interconnect","interface","intersect","join","join_any","join_none","large","let","liblist","library","local","localparam","logic","longint","macromodule","matches","medium","modport","module","nand","negedge","nettype","new","nexttime","nmos","nor","noshowcancelled","not","notif0","notif1","or","output","package","packed","parameter","pmos","posedge","primitive","priority","program","property","protected","pull0","pull1","pulldown","pullup","pulsestyle_ondetect","pulsestyle_onevent","pure","rand","randc","randcase","randsequence","rcmos","real","realtime","ref","reg","reject_on","release","repeat","restrict","return","rnmos","rpmos","rtran","rtranif0","rtranif1","s_always","s_eventually","s_nexttime","s_until","s_until_with","scalared","sequence","shortint","shortreal","showcancelled","signed","small","soft","solve","specify","specparam","static","string","strong","strong0","strong1","struct","super","supply0","supply1","sync_accept_on","sync_reject_on","table","tagged","task","this","throughout","time","timeprecision","timeunit","tran","tranif0","tranif1","tri","tri0","tri1","triand","trior","trireg","type","typedef","union","unique","unique0","unsigned","until","until_with","untyped","use","uwire","var","vectored","virtual","void","wait","wait_order","wand","weak","weak0","weak1","while","wildcard","wire","with","within","wor","xnor","xor"],
literal:["null"],
built_in:["$finish","$stop","$exit","$fatal","$error","$warning","$info","$realtime","$time","$printtimescale","$bitstoreal","$bitstoshortreal","$itor","$signed","$cast","$bits","$stime","$timeformat","$realtobits","$shortrealtobits","$rtoi","$unsigned","$asserton","$assertkill","$assertpasson","$assertfailon","$assertnonvacuouson","$assertoff","$assertcontrol","$assertpassoff","$assertfailoff","$assertvacuousoff","$isunbounded","$sampled","$fell","$changed","$past_gclk","$fell_gclk","$changed_gclk","$rising_gclk","$steady_gclk","$coverage_control","$coverage_get","$coverage_save","$set_coverage_db_name","$rose","$stable","$past","$rose_gclk","$stable_gclk","$future_gclk","$falling_gclk","$changing_gclk","$display","$coverage_get_max","$coverage_merge","$get_coverage","$load_coverage_db","$typename","$unpacked_dimensions","$left","$low","$increment","$clog2","$ln","$log10","$exp","$sqrt","$pow","$floor","$ceil","$sin","$cos","$tan","$countbits","$onehot","$isunknown","$fatal","$warning","$dimensions","$right","$high","$size","$asin","$acos","$atan","$atan2","$hypot","$sinh","$cosh","$tanh","$asinh","$acosh","$atanh","$countones","$onehot0","$error","$info","$random","$dist_chi_square","$dist_erlang","$dist_exponential","$dist_normal","$dist_poisson","$dist_t","$dist_uniform","$q_initialize","$q_remove","$q_exam","$async$and$array","$async$nand$array","$async$or$array","$async$nor$array","$sync$and$array","$sync$nand$array","$sync$or$array","$sync$nor$array","$q_add","$q_full","$psprintf","$async$and$plane","$async$nand$plane","$async$or$plane","$async$nor$plane","$sync$and$plane","$sync$nand$plane","$sync$or$plane","$sync$nor$plane","$system","$display","$displayb","$displayh","$displayo","$strobe","$strobeb","$strobeh","$strobeo","$write","$readmemb","$readmemh","$writememh","$value$plusargs","$dumpvars","$dumpon","$dumplimit","$dumpports","$dumpportson","$dumpportslimit","$writeb","$writeh","$writeo","$monitor","$monitorb","$monitorh","$monitoro","$writememb","$dumpfile","$dumpoff","$dumpall","$dumpflush","$dumpportsoff","$dumpportsall","$dumpportsflush","$fclose","$fdisplay","$fdisplayb","$fdisplayh","$fdisplayo","$fstrobe","$fstrobeb","$fstrobeh","$fstrobeo","$swrite","$swriteb","$swriteh","$swriteo","$fscanf","$fread","$fseek","$fflush","$feof","$fopen","$fwrite","$fwriteb","$fwriteh","$fwriteo","$fmonitor","$fmonitorb","$fmonitorh","$fmonitoro","$sformat","$sformatf","$fgetc","$ungetc","$fgets","$sscanf","$rewind","$ftell","$ferror"]
},contains:[e.C_BLOCK_COMMENT_MODE,e.C_LINE_COMMENT_MODE,e.QUOTE_STRING_MODE,{
scope:"number",contains:[e.BACKSLASH_ESCAPE],variants:[{
begin:/\b((\d+'([bhodBHOD]))[0-9xzXZa-fA-F_]+)/},{
begin:/\B(('([bhodBHOD]))[0-9xzXZa-fA-F_]+)/},{begin:/\b[0-9][0-9_]*/,
relevance:0}]},{scope:"variable",variants:[{begin:"#\\((?!parameter).+\\)"},{
begin:"\\.\\w+",relevance:0}]},{scope:"variable.constant",
match:n.concat(/`/,n.either("__FILE__","__LINE__"))},{scope:"meta",
begin:n.concat(/`/,n.either(...t)),end:/$|\/\/|\/\*/,returnEnd:!0,keywords:t}]}}
})();hljs.registerLanguage("verilog",e)})();
/*! `delphi` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{
const a=["exports","register","file","shl","array","record","property","for","mod","while","set","ally","label","uses","raise","not","stored","class","safecall","var","interface","or","private","static","exit","index","inherited","to","else","stdcall","override","shr","asm","far","resourcestring","finalization","packed","virtual","out","and","protected","library","do","xorwrite","goto","near","function","end","div","overload","object","unit","begin","string","on","inline","repeat","until","destructor","write","message","program","with","read","initialization","except","default","nil","if","case","cdecl","in","downto","threadvar","of","try","pascal","const","external","constructor","type","public","then","implementation","finally","published","procedure","absolute","reintroduce","operator","as","is","abstract","alias","assembler","bitpacked","break","continue","cppdecl","cvar","enumerator","experimental","platform","deprecated","unimplemented","dynamic","export","far16","forward","generic","helper","implements","interrupt","iochecks","local","name","nodefault","noreturn","nostackframe","oldfpccall","otherwise","saveregisters","softfloat","specialize","strict","unaligned","varargs"],r=[e.C_LINE_COMMENT_MODE,e.COMMENT(/\{/,/\}/,{
relevance:0}),e.COMMENT(/\(\*/,/\*\)/,{relevance:10})],t={className:"meta",
variants:[{begin:/\{\$/,end:/\}/},{begin:/\(\*\$/,end:/\*\)/}]},n={
className:"string",begin:/'/,end:/'/,contains:[{begin:/''/}]},s={
className:"string",variants:[{match:/#\d[\d_]*/},{
match:/#\$[\dA-Fa-f][\dA-Fa-f_]*/},{match:/#&[0-7][0-7_]*/},{
match:/#%[01][01_]*/}]},i={begin:e.IDENT_RE+"\\s*=\\s*class\\s*\\(",
returnBegin:!0,contains:[e.TITLE_MODE]},c={className:"function",
beginKeywords:"function constructor destructor procedure",end:/[:;]/,
keywords:"function constructor|10 destructor|10 procedure|10",
contains:[e.TITLE_MODE,{className:"params",begin:/\(/,end:/\)/,keywords:a,
contains:[n,s,t].concat(r)},t].concat(r)};return{name:"Delphi",
aliases:["dpr","dfm","pas","pascal"],case_insensitive:!0,keywords:a,
illegal:/"|\$[G-Zg-z]|\/\*|<\/|\|/,contains:[n,s,{className:"number",
relevance:0,variants:[{match:/\b\d[\d_]*(\.\d[\d_]*)?/},{match:/\$[\dA-Fa-f_]+/
},{match:/\$/,relevance:0},{match:/&[0-7][0-7_]*/},{match:/%[01_]+/},{match:/%/,
relevance:0}]},i,c,t].concat(r)}}})();hljs.registerLanguage("delphi",e)})();
/*! `fsharp` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";function e(e){
return RegExp(e.replace(/[-/\\^$*+?.()|[\]{}]/g,"\\$&"),"m")}function n(e){
return e?"string"==typeof e?e:e.source:null}function t(e){return i("(?=",e,")")}
function i(...e){return e.map(e=>n(e)).join("")}function a(...e){const t=(e=>{
const n=e[e.length-1]
;return"object"==typeof n&&n.constructor===Object?(e.splice(e.length-1,1),n):{}
})(e);return"("+(t.capture?"":"?:")+e.map(e=>n(e)).join("|")+")"}
return RegExp(a(/\[(?:[^\\\]]|\\.)*\]/,/\(\?<(?![=!])[^>]+>/,/\(\?'[^']+'/,/\(\??/,/\\([1-9][0-9]*)/,/\\./)),
n=>{const r={scope:"keyword",match:/\b(yield|return|let|do|match|use)!/
},o=["bool","byte","sbyte","int8","int16","int32","uint8","uint16","uint32","int","uint","int64","uint64","nativeint","unativeint","decimal","float","double","float32","single","char","string","unit","bigint","option","voption","list","array","seq","byref","exn","inref","nativeptr","obj","outref","voidptr","Result"],s={
keyword:["abstract","and","as","assert","base","begin","class","default","delegate","do","done","downcast","downto","elif","else","end","exception","extern","finally","fixed","for","fun","function","global","if","in","inherit","inline","interface","internal","lazy","let","match","member","module","mutable","namespace","new","of","open","or","override","private","public","rec","return","static","struct","then","to","try","type","upcast","use","val","void","when","while","with","yield"],
literal:["true","false","null","Some","None","Ok","Error","infinity","infinityf","nan","nanf"],
built_in:["not","ref","raise","reraise","dict","readOnlyDict","set","get","enum","sizeof","typeof","typedefof","nameof","nullArg","invalidArg","invalidOp","id","fst","snd","ignore","lock","using","box","unbox","tryUnbox","printf","printfn","sprintf","eprintf","eprintfn","fprintf","fprintfn","failwith","failwithf"],
"variable.constant":["__LINE__","__SOURCE_DIRECTORY__","__SOURCE_FILE__"]},c={
variants:[n.COMMENT(/\(\*(?!\))/,/\*\)/,{contains:["self"]
}),n.C_LINE_COMMENT_MODE]},l={scope:"variable",begin:/``/,end:/``/
},p=/\B('|\^)/,u={scope:"symbol",variants:[{match:i(p,/``.*?``/)},{
match:i(p,n.UNDERSCORE_IDENT_RE)}],relevance:0},f=({includeEqual:n})=>{let r
;r=n?"!%&*+-/<=>@^|~?":"!%&*+-/<>@^|~?"
;const o=i("[",...Array.from(r).map(e),"]"),s=a(o,/\./),c=i(s,t(s)),l=a(i(c,s,"*"),i(o,"+"))
;return{scope:"operator",match:a(l,/:\?>/,/:\?/,/:>/,/:=/,/::?/,/\$/),
relevance:0}},d=f({includeEqual:!0}),b=f({includeEqual:!1}),g=(e,r)=>({
begin:i(e,t(i(/\s*/,a(/\w/,/'/,/\^/,/#/,/``/,/\(/,/{\|/)))),beginScope:r,
end:t(a(/\n/,/=/)),relevance:0,keywords:n.inherit(s,{type:o}),
contains:[c,u,n.inherit(l,{scope:null}),b]
}),m=g(/:/,"operator"),h=g(/\bof\b/,"keyword"),y={
begin:[/(^|\s+)/,/type/,/\s+/,/[a-zA-Z_](\w|')*/],beginScope:{2:"keyword",
4:"title.class"},end:t(/\(|=|$/),keywords:s,contains:[c,n.inherit(l,{scope:null
}),u,{scope:"operator",match:/<|>/},m]},E={scope:"computation-expression",
match:/\b[_a-z]\w*(?=\s*\{)/},_={
begin:[/^\s*/,i(/#/,a("if","else","endif","line","nowarn","light","r","i","I","load","time","help","quit")),/\b/],
beginScope:{2:"meta"},end:t(/\s|$/)},v={
variants:[n.BINARY_NUMBER_MODE,n.C_NUMBER_MODE]},w={scope:"string",begin:/"/,
end:/"/,contains:[n.BACKSLASH_ESCAPE]},A={scope:"string",begin:/@"/,end:/"/,
contains:[{match:/""/},n.BACKSLASH_ESCAPE]},S={scope:"string",begin:/"""/,
end:/"""/,relevance:2},C={scope:"subst",begin:/\{/,end:/\}/,keywords:s},O={
scope:"string",begin:/\$"/,end:/"/,contains:[{match:/\{\{/},{match:/\}\}/
},n.BACKSLASH_ESCAPE,C]},R={scope:"string",begin:/(\$@|@\$)"/,end:/"/,
contains:[{match:/\{\{/},{match:/\}\}/},{match:/""/},n.BACKSLASH_ESCAPE,C]},x={
scope:"string",begin:/\$"""/,end:/"""/,contains:[{match:/\{\{/},{match:/\}\}/
},C],relevance:2},k={scope:"string",
match:i(/'/,a(/[^\\']/,/\\(?:.|\d{3}|x[a-fA-F\d]{2}|u[a-fA-F\d]{4}|U[a-fA-F\d]{8})/),/'/)
};return C.contains=[R,O,A,w,k,r,c,l,m,E,_,v,u,d],{name:"F#",
aliases:["fs","f#"],keywords:s,illegal:/\/\*/,classNameAliases:{
"computation-expression":"keyword"},contains:[r,{variants:[x,R,O,S,A,w,k]
},c,l,y,{scope:"meta",begin:/\[</,end:/>\]/,relevance:2,contains:[l,S,A,w,k,v]
},h,m,E,_,v,u,d]}}})();hljs.registerLanguage("fsharp",e)})();
/*! `julia` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{
const r="[A-Za-z_\\u00A1-\\uFFFF][A-Za-z_0-9\\u00A1-\\uFFFF]*",t={$pattern:r,
keyword:["baremodule","begin","break","catch","ccall","const","continue","do","else","elseif","end","export","false","finally","for","function","global","if","import","in","isa","let","local","macro","module","quote","return","true","try","using","where","while"],
literal:["ARGS","C_NULL","DEPOT_PATH","ENDIAN_BOM","ENV","Inf","Inf16","Inf32","Inf64","InsertionSort","LOAD_PATH","MergeSort","NaN","NaN16","NaN32","NaN64","PROGRAM_FILE","QuickSort","RoundDown","RoundFromZero","RoundNearest","RoundNearestTiesAway","RoundNearestTiesUp","RoundToZero","RoundUp","VERSION|0","devnull","false","im","missing","nothing","pi","stderr","stdin","stdout","true","undef","\u03c0","\u212f"],
built_in:["AbstractArray","AbstractChannel","AbstractChar","AbstractDict","AbstractDisplay","AbstractFloat","AbstractIrrational","AbstractMatrix","AbstractRange","AbstractSet","AbstractString","AbstractUnitRange","AbstractVecOrMat","AbstractVector","Any","ArgumentError","Array","AssertionError","BigFloat","BigInt","BitArray","BitMatrix","BitSet","BitVector","Bool","BoundsError","CapturedException","CartesianIndex","CartesianIndices","Cchar","Cdouble","Cfloat","Channel","Char","Cint","Cintmax_t","Clong","Clonglong","Cmd","Colon","Complex","ComplexF16","ComplexF32","ComplexF64","CompositeException","Condition","Cptrdiff_t","Cshort","Csize_t","Cssize_t","Cstring","Cuchar","Cuint","Cuintmax_t","Culong","Culonglong","Cushort","Cvoid","Cwchar_t","Cwstring","DataType","DenseArray","DenseMatrix","DenseVecOrMat","DenseVector","Dict","DimensionMismatch","Dims","DivideError","DomainError","EOFError","Enum","ErrorException","Exception","ExponentialBackOff","Expr","Float16","Float32","Float64","Function","GlobalRef","HTML","IO","IOBuffer","IOContext","IOStream","IdDict","IndexCartesian","IndexLinear","IndexStyle","InexactError","InitError","Int","Int128","Int16","Int32","Int64","Int8","Integer","InterruptException","InvalidStateException","Irrational","KeyError","LinRange","LineNumberNode","LinearIndices","LoadError","MIME","Matrix","Method","MethodError","Missing","MissingException","Module","NTuple","NamedTuple","Nothing","Number","OrdinalRange","OutOfMemoryError","OverflowError","Pair","PartialQuickSort","PermutedDimsArray","Pipe","ProcessFailedException","Ptr","QuoteNode","Rational","RawFD","ReadOnlyMemoryError","Real","ReentrantLock","Ref","Regex","RegexMatch","RoundingMode","SegmentationFault","Set","Signed","Some","StackOverflowError","StepRange","StepRangeLen","StridedArray","StridedMatrix","StridedVecOrMat","StridedVector","String","StringIndexError","SubArray","SubString","SubstitutionString","Symbol","SystemError","Task","TaskFailedException","Text","TextDisplay","Timer","Tuple","Type","TypeError","TypeVar","UInt","UInt128","UInt16","UInt32","UInt64","UInt8","UndefInitializer","UndefKeywordError","UndefRefError","UndefVarError","Union","UnionAll","UnitRange","Unsigned","Val","Vararg","VecElement","VecOrMat","Vector","VersionNumber","WeakKeyDict","WeakRef"]
},n={keywords:t,illegal:/<\//},a={className:"subst",begin:/\$\(/,end:/\)/,
keywords:t},i={className:"variable",begin:"\\$"+r},o={className:"string",
contains:[e.BACKSLASH_ESCAPE,a,i],variants:[{begin:/\w*"""/,end:/"""\w*/,
relevance:10},{begin:/\w*"/,end:/"\w*/}]},s={className:"string",
contains:[e.BACKSLASH_ESCAPE,a,i],begin:"`",end:"`"},l={className:"meta",
begin:"@"+r};return n.name="Julia",n.contains=[{className:"number",
begin:/(\b0x[\d_]*(\.[\d_]*)?|0x\.\d[\d_]*)p[-+]?\d+|\b0[box][a-fA-F0-9][a-fA-F0-9_]*|(\b\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*)([eEfF][-+]?\d+)?/,
relevance:0},{className:"string",begin:/'(.|\\[xXuU][a-zA-Z0-9]+)'/},o,s,l,{
className:"comment",variants:[{begin:"#=",end:"=#",relevance:10},{begin:"#",
end:"$"}]},e.HASH_COMMENT_MODE,{className:"keyword",
begin:"\\b(((abstract|primitive)\\s+)type|(mutable\\s+)?struct)\\b"},{begin:/<:/
}],a.contains=n.contains,n}})();hljs.registerLanguage("julia",e)})();
/*! `tcl` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{
const a=e.regex,t=/[a-zA-Z_][a-zA-Z0-9_]*/,r={className:"number",
variants:[e.BINARY_NUMBER_MODE,e.C_NUMBER_MODE]};return{name:"Tcl",
aliases:["tk"],
keywords:["after","append","apply","array","auto_execok","auto_import","auto_load","auto_mkindex","auto_mkindex_old","auto_qualify","auto_reset","bgerror","binary","break","catch","cd","chan","clock","close","concat","continue","dde","dict","encoding","eof","error","eval","exec","exit","expr","fblocked","fconfigure","fcopy","file","fileevent","filename","flush","for","foreach","format","gets","glob","global","history","http","if","incr","info","interp","join","lappend|10","lassign|10","lindex|10","linsert|10","list","llength|10","load","lrange|10","lrepeat|10","lreplace|10","lreverse|10","lsearch|10","lset|10","lsort|10","mathfunc","mathop","memory","msgcat","namespace","open","package","parray","pid","pkg::create","pkg_mkIndex","platform","platform::shell","proc","puts","pwd","read","refchan","regexp","registry","regsub|10","rename","return","safe","scan","seek","set","socket","source","split","string","subst","switch","tcl_endOfWord","tcl_findLibrary","tcl_startOfNextWord","tcl_startOfPreviousWord","tcl_wordBreakAfter","tcl_wordBreakBefore","tcltest","tclvars","tell","time","tm","trace","unknown","unload","unset","update","uplevel","upvar","variable","vwait","while"],
contains:[e.COMMENT(";[ \\t]*#","$"),e.COMMENT("^[ \\t]*#","$"),{
beginKeywords:"proc",end:"[\\{]",excludeEnd:!0,contains:[{className:"title",
begin:"[ \\t\\n\\r]+(::)?[a-zA-Z_]((::)?[a-zA-Z0-9_])*",end:"[ \\t\\n\\r]",
endsWithParent:!0,excludeEnd:!0}]},{className:"variable",variants:[{
begin:a.concat(/\$/,a.optional(/::/),t,"(::",t,")*")},{
begin:"\\$\\{(::)?[a-zA-Z_]((::)?[a-zA-Z0-9_])*",end:"\\}",contains:[r]}]},{
className:"string",contains:[e.BACKSLASH_ESCAPE],
variants:[e.inherit(e.QUOTE_STRING_MODE,{illegal:null})]},r]}}})()
;hljs.registerLanguage("tcl",e)})();
/*! `coffeescript` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict"
;const e=["as","in","of","if","for","while","finally","var","new","function","do","return","void","else","break","catch","instanceof","with","throw","case","default","try","switch","continue","typeof","delete","let","yield","const","class","debugger","async","await","static","import","from","export","extends","using"],n=["true","false","null","undefined","NaN","Infinity"],r=[].concat(["setInterval","setTimeout","clearInterval","clearTimeout","require","exports","eval","isFinite","isNaN","parseFloat","parseInt","decodeURI","decodeURIComponent","encodeURI","encodeURIComponent","escape","unescape"],["Object","Function","Boolean","Symbol","Math","Date","Number","BigInt","String","RegExp","Array","Float32Array","Float64Array","Int8Array","Uint8Array","Uint8ClampedArray","Int16Array","Int32Array","Uint16Array","Uint32Array","BigInt64Array","BigUint64Array","Set","Map","WeakSet","WeakMap","ArrayBuffer","SharedArrayBuffer","Atomics","DataView","JSON","Promise","Generator","GeneratorFunction","AsyncFunction","Reflect","Proxy","Intl","WebAssembly"],["Error","EvalError","InternalError","RangeError","ReferenceError","SyntaxError","TypeError","URIError"])
;return t=>{const a={
keyword:e.concat(["then","unless","until","loop","by","when","and","or","is","isnt","not"]).filter((i=["var","const","let","function","static"],
e=>!i.includes(e))),literal:n.concat(["yes","no","on","off"]),
built_in:r.concat(["npm","print"])};var i;const s="[A-Za-z$_][0-9A-Za-z$_]*",o={
className:"subst",begin:/#\{/,end:/\}/,keywords:a
},c=[t.BINARY_NUMBER_MODE,t.inherit(t.C_NUMBER_MODE,{starts:{end:"(\\s*/)?",
relevance:0}}),{className:"string",variants:[{begin:/'''/,end:/'''/,
contains:[t.BACKSLASH_ESCAPE]},{begin:/'/,end:/'/,contains:[t.BACKSLASH_ESCAPE]
},{begin:/"""/,end:/"""/,contains:[t.BACKSLASH_ESCAPE,o]},{begin:/"/,end:/"/,
contains:[t.BACKSLASH_ESCAPE,o]}]},{className:"regexp",variants:[{begin:"///",
end:"///",contains:[o,t.HASH_COMMENT_MODE]},{begin:"//[gim]{0,3}(?=\\W)",
relevance:0},{begin:/\/(?![ *]).*?(?![\\]).\/[gim]{0,3}(?=\W)/}]},{begin:"@"+s
},{subLanguage:"javascript",excludeBegin:!0,excludeEnd:!0,variants:[{
begin:"```",end:"```"},{begin:"`",end:"`"}]}];o.contains=c
;const l=t.inherit(t.TITLE_MODE,{begin:s}),d="(\\(.*\\)\\s*)?\\B[-=]>",g={
className:"params",begin:"\\([^\\(]",returnBegin:!0,contains:[{begin:/\(/,
end:/\)/,keywords:a,contains:["self"].concat(c)}]},u={variants:[{
match:[/class\s+/,s,/\s+extends\s+/,s]},{match:[/class\s+/,s]}],scope:{
2:"title.class",4:"title.class.inherited"},keywords:a};return{
name:"CoffeeScript",aliases:["coffee","cson","iced"],keywords:a,illegal:/\/\*/,
contains:[...c,t.COMMENT("###","###"),t.HASH_COMMENT_MODE,{className:"function",
begin:"^\\s*"+s+"\\s*=\\s*"+d,end:"[-=]>",returnBegin:!0,contains:[l,g]},{
begin:/[:\(,=]\s*/,relevance:0,contains:[{className:"function",begin:d,
end:"[-=]>",returnBegin:!0,contains:[g]}]},u,{begin:s+":",end:":",
returnBegin:!0,returnEnd:!0,relevance:0}]}}})()
;hljs.registerLanguage("coffeescript",e)})();
/*! `handlebars` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{const a=e.regex,n={
$pattern:/[\w.\/]+/,
built_in:["action","bindattr","collection","component","concat","debugger","each","each-in","get","hash","if","in","input","link-to","loc","log","lookup","mut","outlet","partial","query-params","render","template","textarea","unbound","unless","view","with","yield"]
},t=/\[\]|\[[^\]]+\]/,s=/[^\s!"#%&'()*+,.\/;<=>@\[\\\]^`{|}~]+/,i=a.either(/""|"[^"]+"/,/''|'[^']+'/,t,s),r=a.concat(a.optional(/\.|\.\/|\//),i,a.anyNumberOfTimes(a.concat(/(\.|\/)/,i))),l=a.concat("(",t,"|",s,")(?==)"),c={
begin:r},o=e.inherit(c,{keywords:{$pattern:/[\w.\/]+/,
literal:["true","false","undefined","null"]}}),m={begin:/\(/,end:/\)/},d={
className:"attr",begin:l,relevance:0,starts:{begin:/=/,end:/=/,starts:{
contains:[e.NUMBER_MODE,e.QUOTE_STRING_MODE,e.APOS_STRING_MODE,o,m]}}},g={
contains:[e.NUMBER_MODE,e.QUOTE_STRING_MODE,e.APOS_STRING_MODE,{begin:/as\s+\|/,
keywords:{keyword:"as"},end:/\|/,contains:[{begin:/\w+/}]},d,o,m],returnEnd:!0
},b=e.inherit(c,{className:"name",keywords:n,starts:e.inherit(g,{end:/\)/})})
;m.contains=[b];const u=e.inherit(c,{keywords:n,className:"name",
starts:e.inherit(g,{end:/\}\}/})}),h=e.inherit(c,{keywords:n,className:"name"
}),N=e.inherit(c,{className:"name",keywords:n,starts:e.inherit(g,{end:/\}\}/})})
;return{name:"Handlebars",
aliases:["hbs","html.hbs","html.handlebars","htmlbars"],case_insensitive:!0,
subLanguage:"xml",contains:[{begin:/\\\{\{/,skip:!0},{begin:/\\\\(?=\{\{)/,
skip:!0},e.COMMENT(/\{\{!--/,/--\}\}/),e.COMMENT(/\{\{!/,/\}\}/),{
className:"template-tag",begin:/\{\{\{\{(?!\/)/,end:/\}\}\}\}/,contains:[u],
starts:{end:/\{\{\{\{\//,returnEnd:!0,subLanguage:"xml"}},{
className:"template-tag",begin:/\{\{\{\{\//,end:/\}\}\}\}/,contains:[h]},{
className:"template-tag",begin:/\{\{#/,end:/\}\}/,contains:[u]},{
className:"template-tag",begin:/\{\{(?=else\}\})/,end:/\}\}/,keywords:"else"},{
className:"template-tag",begin:/\{\{(?=else if)/,end:/\}\}/,keywords:"else if"
},{className:"template-tag",begin:/\{\{\//,end:/\}\}/,contains:[h]},{
className:"template-variable",begin:/\{\{\{/,end:/\}\}\}/,contains:[N]},{
className:"template-variable",begin:/\{\{/,end:/\}\}/,contains:[N]}]}}})()
;hljs.registerLanguage("handlebars",e)})();
/*! `scheme` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{
const t="[^\\(\\)\\[\\]\\{\\}\",'`;#|\\\\\\s]+",n="(-|\\+)?\\d+([./]\\d+)?",r={
$pattern:t,
built_in:"case-lambda call/cc class define-class exit-handler field import inherit init-field interface let*-values let-values let/ec mixin opt-lambda override protect provide public rename require require-for-syntax syntax syntax-case syntax-error unit/sig unless when with-syntax and begin call-with-current-continuation call-with-input-file call-with-output-file case cond define define-syntax delay do dynamic-wind else for-each if lambda let let* let-syntax letrec letrec-syntax map or syntax-rules ' * + , ,@ - ... / ; < <= = => > >= ` abs acos angle append apply asin assoc assq assv atan boolean? caar cadr call-with-input-file call-with-output-file call-with-values car cdddar cddddr cdr ceiling char->integer char-alphabetic? char-ci<=? char-ci<? char-ci=? char-ci>=? char-ci>? char-downcase char-lower-case? char-numeric? char-ready? char-upcase char-upper-case? char-whitespace? char<=? char<? char=? char>=? char>? char? close-input-port close-output-port complex? cons cos current-input-port current-output-port denominator display eof-object? eq? equal? eqv? eval even? exact->inexact exact? exp expt floor force gcd imag-part inexact->exact inexact? input-port? integer->char integer? interaction-environment lcm length list list->string list->vector list-ref list-tail list? load log magnitude make-polar make-rectangular make-string make-vector max member memq memv min modulo negative? newline not null-environment null? number->string number? numerator odd? open-input-file open-output-file output-port? pair? peek-char port? positive? procedure? quasiquote quote quotient rational? rationalize read read-char real-part real? remainder reverse round scheme-report-environment set! set-car! set-cdr! sin sqrt string string->list string->number string->symbol string-append string-ci<=? string-ci<? string-ci=? string-ci>=? string-ci>? string-copy string-fill! string-length string-ref string-set! string<=? string<? string=? string>=? string>? string? substring symbol->string symbol? tan transcript-off transcript-on truncate values vector vector->list vector-fill! vector-length vector-ref vector-set! with-input-from-file with-output-to-file write write-char zero?"
},a={className:"literal",begin:"(#t|#f|#\\\\"+t+"|#\\\\.)"},i={
className:"number",variants:[{begin:n,relevance:0},{begin:n+"[+\\-]"+n+"i",
relevance:0},{begin:"#b[0-1]+(/[0-1]+)?"},{begin:"#o[0-7]+(/[0-7]+)?"},{
begin:"#x[0-9a-f]+(/[0-9a-f]+)?"}]},c=e.QUOTE_STRING_MODE,s=[e.COMMENT(";","$",{
relevance:0}),e.COMMENT("#\\|","\\|#")],l={begin:t,relevance:0},o={
className:"symbol",begin:"'"+t},g={endsWithParent:!0,relevance:0},u={variants:[{
begin:/'/},{begin:"`"}],contains:[{begin:"\\(",end:"\\)",
contains:["self",a,c,i,l,o]}]},d={className:"name",relevance:0,begin:t,
keywords:r},p={variants:[{begin:"\\(",end:"\\)"},{begin:"\\[",end:"\\]"}],
contains:[{begin:/lambda/,endsWithParent:!0,returnBegin:!0,contains:[d,{
endsParent:!0,variants:[{begin:/\(/,end:/\)/},{begin:/\[/,end:/\]/}],
contains:[l]}]},d,g]};return g.contains=[a,i,c,l,o,u,p].concat(s),{
name:"Scheme",aliases:["scm"],illegal:/\S/,
contains:[e.SHEBANG(),i,c,o,u,p].concat(s)}}})()
;hljs.registerLanguage("scheme",e)})();
/*! `twig` grammar compiled for Highlight.js 11.12.0 */
(()=>{var e=(()=>{"use strict";return e=>{
const a=e.regex,t=["absolute_url","asset|0","asset_version","attribute","block","constant","controller|0","country_timezones","csrf_token","cycle","date","dump","expression","form|0","form_end","form_errors","form_help","form_label","form_rest","form_row","form_start","form_widget","html_classes","include","is_granted","logout_path","logout_url","max","min","parent","path|0","random","range","relative_path","render","render_esi","source","template_from_string","url|0"]
;let r=["apply","autoescape","block","cache","deprecated","do","embed","extends","filter","flush","for","form_theme","from","if","import","include","macro","sandbox","set","stopwatch","trans","trans_default_domain","transchoice","use","verbatim","with"]
;r=r.concat(r.map(e=>"end"+e));const n={scope:"string",variants:[{begin:/'/,
end:/'/},{begin:/"/,end:/"/}]},o={scope:"number",match:/\d+/},s={begin:/\(/,
end:/\)/,excludeBegin:!0,excludeEnd:!0,contains:[n,o]},c={
beginKeywords:t.join(" "),keywords:{name:t},relevance:0,contains:[s]},m={
match:/\|(?=[A-Za-z_]+:?)/,beginScope:"punctuation",relevance:0,contains:[{
match:/[A-Za-z_]+:?/,
keywords:["abs","abbr_class","abbr_method","batch","capitalize","column","convert_encoding","country_name","currency_name","currency_symbol","data_uri","date","date_modify","default","escape","file_excerpt","file_link","file_relative","filter","first","format","format_args","format_args_as_text","format_currency","format_date","format_datetime","format_file","format_file_from_text","format_number","format_time","html_to_markdown","humanize","inky_to_html","inline_css","join","json_encode","keys","language_name","last","length","locale_name","lower","map","markdown","markdown_to_html","merge","nl2br","number_format","raw","reduce","replace","reverse","round","slice","slug","sort","spaceless","split","striptags","timezone_name","title","trans","transchoice","trim","u|0","upper","url_encode","yaml_dump","yaml_encode"]
}]},i=(e,{relevance:t})=>({beginScope:{1:"template-tag",3:"name"},
relevance:t||2,endScope:"template-tag",begin:[/\{%/,/\s*/,a.either(...e)],
end:/%\}/,keywords:"in",contains:[m,c,n,o]}),l=i(r,{relevance:2
}),_=i([/[a-z_]+/],{relevance:1});return{name:"Twig",aliases:["craftcms"],
case_insensitive:!0,subLanguage:"xml",contains:[e.COMMENT(/\{#/,/#\}/),l,_,{
className:"template-variable",begin:/\{\{/,end:/\}\}/,contains:["self",m,c,n,o]
}]}}})();hljs.registerLanguage("twig",e)})();
/*! `pgsql` grammar compiled for Highlight.js 11.12.0 */
(()=>{var E=(()=>{"use strict";return E=>{
const T=E.COMMENT("--","$"),N="\\$([a-zA-Z_]?|[a-zA-Z_][a-zA-Z_0-9]*)\\$",A="BIGINT INT8 BIGSERIAL SERIAL8 BIT VARYING VARBIT BOOLEAN BOOL BOX BYTEA CHARACTER CHAR VARCHAR CIDR CIRCLE DATE DOUBLE PRECISION FLOAT8 FLOAT INET INTEGER INT INT4 INTERVAL JSON JSONB LINE LSEG|10 MACADDR MACADDR8 MONEY NUMERIC DEC DECIMAL PATH POINT POLYGON REAL FLOAT4 SMALLINT INT2 SMALLSERIAL|10 SERIAL2|10 SERIAL|10 SERIAL4|10 TEXT TIME ZONE TIMETZ|10 TIMESTAMP TIMESTAMPTZ|10 TSQUERY|10 TSVECTOR|10 TXID_SNAPSHOT|10 UUID XML NATIONAL NCHAR INT4RANGE|10 INT8RANGE|10 NUMRANGE|10 TSRANGE|10 TSTZRANGE|10 DATERANGE|10 ANYELEMENT ANYARRAY ANYNONARRAY ANYENUM ANYRANGE CSTRING INTERNAL RECORD PG_DDL_COMMAND VOID UNKNOWN OPAQUE REFCURSOR NAME OID REGPROC|10 REGPROCEDURE|10 REGOPER|10 REGOPERATOR|10 REGCLASS|10 REGTYPE|10 REGROLE|10 REGNAMESPACE|10 REGCONFIG|10 REGDICTIONARY|10 ",R=A.trim().split(" ").map(E=>E.split("|")[0]).join("|"),I="ARRAY_AGG AVG BIT_AND BIT_OR BOOL_AND BOOL_OR COUNT EVERY JSON_AGG JSONB_AGG JSON_OBJECT_AGG JSONB_OBJECT_AGG MAX MIN MODE STRING_AGG SUM XMLAGG CORR COVAR_POP COVAR_SAMP REGR_AVGX REGR_AVGY REGR_COUNT REGR_INTERCEPT REGR_R2 REGR_SLOPE REGR_SXX REGR_SXY REGR_SYY STDDEV STDDEV_POP STDDEV_SAMP VARIANCE VAR_POP VAR_SAMP PERCENTILE_CONT PERCENTILE_DISC ROW_NUMBER RANK DENSE_RANK PERCENT_RANK CUME_DIST NTILE LAG LEAD FIRST_VALUE LAST_VALUE NTH_VALUE NUM_NONNULLS NUM_NULLS ABS CBRT CEIL CEILING DEGREES DIV EXP FLOOR LN LOG MOD PI POWER RADIANS ROUND SCALE SIGN SQRT TRUNC WIDTH_BUCKET RANDOM SETSEED ACOS ACOSD ASIN ASIND ATAN ATAND ATAN2 ATAN2D COS COSD COT COTD SIN SIND TAN TAND BIT_LENGTH CHAR_LENGTH CHARACTER_LENGTH LOWER OCTET_LENGTH OVERLAY POSITION SUBSTRING TREAT TRIM UPPER ASCII BTRIM CHR CONCAT CONCAT_WS CONVERT CONVERT_FROM CONVERT_TO DECODE ENCODE INITCAP LEFT LENGTH LPAD LTRIM MD5 PARSE_IDENT PG_CLIENT_ENCODING QUOTE_IDENT|10 QUOTE_LITERAL|10 QUOTE_NULLABLE|10 REGEXP_MATCH REGEXP_MATCHES REGEXP_REPLACE REGEXP_SPLIT_TO_ARRAY REGEXP_SPLIT_TO_TABLE REPEAT REPLACE REVERSE RIGHT RPAD RTRIM SPLIT_PART STRPOS SUBSTR TO_ASCII TO_HEX TRANSLATE OCTET_LENGTH GET_BIT GET_BYTE SET_BIT SET_BYTE TO_CHAR TO_DATE TO_NUMBER TO_TIMESTAMP AGE CLOCK_TIMESTAMP|10 DATE_PART DATE_TRUNC ISFINITE JUSTIFY_DAYS JUSTIFY_HOURS JUSTIFY_INTERVAL MAKE_DATE MAKE_INTERVAL|10 MAKE_TIME MAKE_TIMESTAMP|10 MAKE_TIMESTAMPTZ|10 NOW STATEMENT_TIMESTAMP|10 TIMEOFDAY TRANSACTION_TIMESTAMP|10 ENUM_FIRST ENUM_LAST ENUM_RANGE AREA CENTER DIAMETER HEIGHT ISCLOSED ISOPEN NPOINTS PCLOSE POPEN RADIUS WIDTH BOX BOUND_BOX CIRCLE LINE LSEG PATH POLYGON ABBREV BROADCAST HOST HOSTMASK MASKLEN NETMASK NETWORK SET_MASKLEN TEXT INET_SAME_FAMILY INET_MERGE MACADDR8_SET7BIT ARRAY_TO_TSVECTOR GET_CURRENT_TS_CONFIG NUMNODE PLAINTO_TSQUERY PHRASETO_TSQUERY WEBSEARCH_TO_TSQUERY QUERYTREE SETWEIGHT STRIP TO_TSQUERY TO_TSVECTOR JSON_TO_TSVECTOR JSONB_TO_TSVECTOR TS_DELETE TS_FILTER TS_HEADLINE TS_RANK TS_RANK_CD TS_REWRITE TSQUERY_PHRASE TSVECTOR_TO_ARRAY TSVECTOR_UPDATE_TRIGGER TSVECTOR_UPDATE_TRIGGER_COLUMN XMLCOMMENT XMLCONCAT XMLELEMENT XMLFOREST XMLPI XMLROOT XMLEXISTS XML_IS_WELL_FORMED XML_IS_WELL_FORMED_DOCUMENT XML_IS_WELL_FORMED_CONTENT XPATH XPATH_EXISTS XMLTABLE XMLNAMESPACES TABLE_TO_XML TABLE_TO_XMLSCHEMA TABLE_TO_XML_AND_XMLSCHEMA QUERY_TO_XML QUERY_TO_XMLSCHEMA QUERY_TO_XML_AND_XMLSCHEMA CURSOR_TO_XML CURSOR_TO_XMLSCHEMA SCHEMA_TO_XML SCHEMA_TO_XMLSCHEMA SCHEMA_TO_XML_AND_XMLSCHEMA DATABASE_TO_XML DATABASE_TO_XMLSCHEMA DATABASE_TO_XML_AND_XMLSCHEMA XMLATTRIBUTES TO_JSON TO_JSONB ARRAY_TO_JSON ROW_TO_JSON JSON_BUILD_ARRAY JSONB_BUILD_ARRAY JSON_BUILD_OBJECT JSONB_BUILD_OBJECT JSON_OBJECT JSONB_OBJECT JSON_ARRAY_LENGTH JSONB_ARRAY_LENGTH JSON_EACH JSONB_EACH JSON_EACH_TEXT JSONB_EACH_TEXT JSON_EXTRACT_PATH JSONB_EXTRACT_PATH JSON_OBJECT_KEYS JSONB_OBJECT_KEYS JSON_POPULATE_RECORD JSONB_POPULATE_RECORD JSON_POPULATE_RECORDSET JSONB_POPULATE_RECORDSET JSON_ARRAY_ELEMENTS JSONB_ARRAY_ELEMENTS JSON_ARRAY_ELEMENTS_TEXT JSONB_ARRAY_ELEMENTS_TEXT JSON_TYPEOF JSONB_TYPEOF JSON_TO_RECORD JSONB_TO_RECORD JSON_TO_RECORDSET JSONB_TO_RECORDSET JSON_STRIP_NULLS JSONB_STRIP_NULLS JSONB_SET JSONB_INSERT JSONB_PRETTY CURRVAL LASTVAL NEXTVAL SETVAL COALESCE NULLIF GREATEST LEAST ARRAY_APPEND ARRAY_CAT ARRAY_NDIMS ARRAY_DIMS ARRAY_FILL ARRAY_LENGTH ARRAY_LOWER ARRAY_POSITION ARRAY_POSITIONS ARRAY_PREPEND ARRAY_REMOVE ARRAY_REPLACE ARRAY_TO_STRING ARRAY_UPPER CARDINALITY STRING_TO_ARRAY UNNEST ISEMPTY LOWER_INC UPPER_INC LOWER_INF UPPER_INF RANGE_MERGE GENERATE_SERIES GENERATE_SUBSCRIPTS CURRENT_DATABASE CURRENT_QUERY CURRENT_SCHEMA|10 CURRENT_SCHEMAS|10 INET_CLIENT_ADDR INET_CLIENT_PORT INET_SERVER_ADDR INET_SERVER_PORT ROW_SECURITY_ACTIVE FORMAT_TYPE TO_REGCLASS TO_REGPROC TO_REGPROCEDURE TO_REGOPER TO_REGOPERATOR TO_REGTYPE TO_REGNAMESPACE TO_REGROLE COL_DESCRIPTION OBJ_DESCRIPTION SHOBJ_DESCRIPTION TXID_CURRENT TXID_CURRENT_IF_ASSIGNED TXID_CURRENT_SNAPSHOT TXID_SNAPSHOT_XIP TXID_SNAPSHOT_XMAX TXID_SNAPSHOT_XMIN TXID_VISIBLE_IN_SNAPSHOT TXID_STATUS CURRENT_SETTING SET_CONFIG BRIN_SUMMARIZE_NEW_VALUES BRIN_SUMMARIZE_RANGE BRIN_DESUMMARIZE_RANGE GIN_CLEAN_PENDING_LIST SUPPRESS_REDUNDANT_UPDATES_TRIGGER LO_FROM_BYTEA LO_PUT LO_GET LO_CREAT LO_CREATE LO_UNLINK LO_IMPORT LO_EXPORT LOREAD LOWRITE GROUPING CAST".split(" ").map(E=>E.split("|")[0]).join("|")
;return{name:"PostgreSQL",aliases:["postgres","postgresql"],supersetOf:"sql",
case_insensitive:!0,keywords:{
keyword:"ABORT ALTER ANALYZE BEGIN CALL CHECKPOINT|10 CLOSE CLUSTER COMMENT COMMIT COPY CREATE DEALLOCATE DECLARE DELETE DISCARD DO DROP END EXECUTE EXPLAIN FETCH GRANT IMPORT INSERT LISTEN LOAD LOCK MOVE NOTIFY PREPARE REASSIGN|10 REFRESH REINDEX RELEASE RESET REVOKE ROLLBACK SAVEPOINT SECURITY SELECT SET SHOW START TRUNCATE UNLISTEN|10 UPDATE VACUUM|10 VALUES AGGREGATE COLLATION CONVERSION|10 DATABASE DEFAULT PRIVILEGES DOMAIN TRIGGER EXTENSION FOREIGN WRAPPER|10 TABLE FUNCTION GROUP LANGUAGE LARGE OBJECT MATERIALIZED VIEW OPERATOR CLASS FAMILY POLICY PUBLICATION|10 ROLE RULE SCHEMA SEQUENCE SERVER STATISTICS SUBSCRIPTION SYSTEM TABLESPACE CONFIGURATION DICTIONARY PARSER TEMPLATE TYPE USER MAPPING PREPARED ACCESS METHOD CAST AS TRANSFORM TRANSACTION OWNED TO INTO SESSION AUTHORIZATION INDEX PROCEDURE ASSERTION ALL ANALYSE AND ANY ARRAY ASC ASYMMETRIC|10 BOTH CASE CHECK COLLATE COLUMN CONCURRENTLY|10 CONSTRAINT CROSS DEFERRABLE RANGE DESC DISTINCT ELSE EXCEPT FOR FREEZE|10 FROM FULL HAVING ILIKE IN INITIALLY INNER INTERSECT IS ISNULL JOIN LATERAL LEADING LIKE LIMIT NATURAL NOT NOTNULL NULL OFFSET ON ONLY OR ORDER OUTER OVERLAPS PLACING PRIMARY REFERENCES RETURNING SIMILAR SOME SYMMETRIC TABLESAMPLE THEN TRAILING UNION UNIQUE USING VARIADIC|10 VERBOSE WHEN WHERE WINDOW WITH BY RETURNS INOUT OUT SETOF|10 IF STRICT CURRENT CONTINUE OWNER LOCATION OVER PARTITION WITHIN BETWEEN ESCAPE EXTERNAL INVOKER DEFINER WORK RENAME VERSION CONNECTION CONNECT TABLES TEMP TEMPORARY FUNCTIONS SEQUENCES TYPES SCHEMAS OPTION CASCADE RESTRICT ADD ADMIN EXISTS VALID VALIDATE ENABLE DISABLE REPLICA|10 ALWAYS PASSING COLUMNS PATH REF VALUE OVERRIDING IMMUTABLE STABLE VOLATILE BEFORE AFTER EACH ROW PROCEDURAL ROUTINE NO HANDLER VALIDATOR OPTIONS STORAGE OIDS|10 WITHOUT INHERIT DEPENDS CALLED INPUT LEAKPROOF|10 COST ROWS NOWAIT SEARCH UNTIL ENCRYPTED|10 PASSWORD CONFLICT|10 INSTEAD INHERITS CHARACTERISTICS WRITE CURSOR ALSO STATEMENT SHARE EXCLUSIVE INLINE ISOLATION REPEATABLE READ COMMITTED SERIALIZABLE UNCOMMITTED LOCAL GLOBAL SQL PROCEDURES RECURSIVE SNAPSHOT ROLLUP CUBE TRUSTED|10 INCLUDE FOLLOWING PRECEDING UNBOUNDED RANGE GROUPS UNENCRYPTED|10 SYSID FORMAT DELIMITER HEADER QUOTE ENCODING FILTER OFF FORCE_QUOTE FORCE_NOT_NULL FORCE_NULL COSTS BUFFERS TIMING SUMMARY DISABLE_PAGE_SKIPPING RESTART CYCLE GENERATED IDENTITY DEFERRED IMMEDIATE LEVEL LOGGED UNLOGGED OF NOTHING NONE EXCLUDE ATTRIBUTE USAGE ROUTINES TRUE FALSE NAN INFINITY ALIAS BEGIN CONSTANT DECLARE END EXCEPTION RETURN PERFORM|10 RAISE GET DIAGNOSTICS STACKED|10 FOREACH LOOP ELSIF EXIT WHILE REVERSE SLICE DEBUG LOG INFO NOTICE WARNING ASSERT OPEN SUPERUSER NOSUPERUSER CREATEDB NOCREATEDB CREATEROLE NOCREATEROLE INHERIT NOINHERIT LOGIN NOLOGIN REPLICATION NOREPLICATION BYPASSRLS NOBYPASSRLS ",
built_in:"CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURRENT_CATALOG|10 CURRENT_DATE LOCALTIME LOCALTIMESTAMP CURRENT_ROLE|10 CURRENT_SCHEMA|10 SESSION_USER PUBLIC FOUND NEW OLD TG_NAME|10 TG_WHEN|10 TG_LEVEL|10 TG_OP|10 TG_RELID|10 TG_RELNAME|10 TG_TABLE_NAME|10 TG_TABLE_SCHEMA|10 TG_NARGS|10 TG_ARGV|10 TG_EVENT|10 TG_TAG|10 ROW_COUNT RESULT_OID|10 PG_CONTEXT|10 RETURNED_SQLSTATE COLUMN_NAME CONSTRAINT_NAME PG_DATATYPE_NAME|10 MESSAGE_TEXT TABLE_NAME SCHEMA_NAME PG_EXCEPTION_DETAIL|10 PG_EXCEPTION_HINT|10 PG_EXCEPTION_CONTEXT|10 SQLSTATE SQLERRM|10 SUCCESSFUL_COMPLETION WARNING DYNAMIC_RESULT_SETS_RETURNED IMPLICIT_ZERO_BIT_PADDING NULL_VALUE_ELIMINATED_IN_SET_FUNCTION PRIVILEGE_NOT_GRANTED PRIVILEGE_NOT_REVOKED STRING_DATA_RIGHT_TRUNCATION DEPRECATED_FEATURE NO_DATA NO_ADDITIONAL_DYNAMIC_RESULT_SETS_RETURNED SQL_STATEMENT_NOT_YET_COMPLETE CONNECTION_EXCEPTION CONNECTION_DOES_NOT_EXIST CONNECTION_FAILURE SQLCLIENT_UNABLE_TO_ESTABLISH_SQLCONNECTION SQLSERVER_REJECTED_ESTABLISHMENT_OF_SQLCONNECTION TRANSACTION_RESOLUTION_UNKNOWN PROTOCOL_VIOLATION TRIGGERED_ACTION_EXCEPTION FEATURE_NOT_SUPPORTED INVALID_TRANSACTION_INITIATION LOCATOR_EXCEPTION INVALID_LOCATOR_SPECIFICATION INVALID_GRANTOR INVALID_GRANT_OPERATION INVALID_ROLE_SPECIFICATION DIAGNOSTICS_EXCEPTION STACKED_DIAGNOSTICS_ACCESSED_WITHOUT_ACTIVE_HANDLER CASE_NOT_FOUND CARDINALITY_VIOLATION DATA_EXCEPTION ARRAY_SUBSCRIPT_ERROR CHARACTER_NOT_IN_REPERTOIRE DATETIME_FIELD_OVERFLOW DIVISION_BY_ZERO ERROR_IN_ASSIGNMENT ESCAPE_CHARACTER_CONFLICT INDICATOR_OVERFLOW INTERVAL_FIELD_OVERFLOW INVALID_ARGUMENT_FOR_LOGARITHM INVALID_ARGUMENT_FOR_NTILE_FUNCTION INVALID_ARGUMENT_FOR_NTH_VALUE_FUNCTION INVALID_ARGUMENT_FOR_POWER_FUNCTION INVALID_ARGUMENT_FOR_WIDTH_BUCKET_FUNCTION INVALID_CHARACTER_VALUE_FOR_CAST INVALID_DATETIME_FORMAT INVALID_ESCAPE_CHARACTER INVALID_ESCAPE_OCTET INVALID_ESCAPE_SEQUENCE NONSTANDARD_USE_OF_ESCAPE_CHARACTER INVALID_INDICATOR_PARAMETER_VALUE INVALID_PARAMETER_VALUE INVALID_REGULAR_EXPRESSION INVALID_ROW_COUNT_IN_LIMIT_CLAUSE INVALID_ROW_COUNT_IN_RESULT_OFFSET_CLAUSE INVALID_TABLESAMPLE_ARGUMENT INVALID_TABLESAMPLE_REPEAT INVALID_TIME_ZONE_DISPLACEMENT_VALUE INVALID_USE_OF_ESCAPE_CHARACTER MOST_SPECIFIC_TYPE_MISMATCH NULL_VALUE_NOT_ALLOWED NULL_VALUE_NO_INDICATOR_PARAMETER NUMERIC_VALUE_OUT_OF_RANGE SEQUENCE_GENERATOR_LIMIT_EXCEEDED STRING_DATA_LENGTH_MISMATCH STRING_DATA_RIGHT_TRUNCATION SUBSTRING_ERROR TRIM_ERROR UNTERMINATED_C_STRING ZERO_LENGTH_CHARACTER_STRING FLOATING_POINT_EXCEPTION INVALID_TEXT_REPRESENTATION INVALID_BINARY_REPRESENTATION BAD_COPY_FILE_FORMAT UNTRANSLATABLE_CHARACTER NOT_AN_XML_DOCUMENT INVALID_XML_DOCUMENT INVALID_XML_CONTENT INVALID_XML_COMMENT INVALID_XML_PROCESSING_INSTRUCTION INTEGRITY_CONSTRAINT_VIOLATION RESTRICT_VIOLATION NOT_NULL_VIOLATION FOREIGN_KEY_VIOLATION UNIQUE_VIOLATION CHECK_VIOLATION EXCLUSION_VIOLATION INVALID_CURSOR_STATE INVALID_TRANSACTION_STATE ACTIVE_SQL_TRANSACTION BRANCH_TRANSACTION_ALREADY_ACTIVE HELD_CURSOR_REQUIRES_SAME_ISOLATION_LEVEL INAPPROPRIATE_ACCESS_MODE_FOR_BRANCH_TRANSACTION INAPPROPRIATE_ISOLATION_LEVEL_FOR_BRANCH_TRANSACTION NO_ACTIVE_SQL_TRANSACTION_FOR_BRANCH_TRANSACTION READ_ONLY_SQL_TRANSACTION SCHEMA_AND_DATA_STATEMENT_MIXING_NOT_SUPPORTED NO_ACTIVE_SQL_TRANSACTION IN_FAILED_SQL_TRANSACTION IDLE_IN_TRANSACTION_SESSION_TIMEOUT INVALID_SQL_STATEMENT_NAME TRIGGERED_DATA_CHANGE_VIOLATION INVALID_AUTHORIZATION_SPECIFICATION INVALID_PASSWORD DEPENDENT_PRIVILEGE_DESCRIPTORS_STILL_EXIST DEPENDENT_OBJECTS_STILL_EXIST INVALID_TRANSACTION_TERMINATION SQL_ROUTINE_EXCEPTION FUNCTION_EXECUTED_NO_RETURN_STATEMENT MODIFYING_SQL_DATA_NOT_PERMITTED PROHIBITED_SQL_STATEMENT_ATTEMPTED READING_SQL_DATA_NOT_PERMITTED INVALID_CURSOR_NAME EXTERNAL_ROUTINE_EXCEPTION CONTAINING_SQL_NOT_PERMITTED MODIFYING_SQL_DATA_NOT_PERMITTED PROHIBITED_SQL_STATEMENT_ATTEMPTED READING_SQL_DATA_NOT_PERMITTED EXTERNAL_ROUTINE_INVOCATION_EXCEPTION INVALID_SQLSTATE_RETURNED NULL_VALUE_NOT_ALLOWED TRIGGER_PROTOCOL_VIOLATED SRF_PROTOCOL_VIOLATED EVENT_TRIGGER_PROTOCOL_VIOLATED SAVEPOINT_EXCEPTION INVALID_SAVEPOINT_SPECIFICATION INVALID_CATALOG_NAME INVALID_SCHEMA_NAME TRANSACTION_ROLLBACK TRANSACTION_INTEGRITY_CONSTRAINT_VIOLATION SERIALIZATION_FAILURE STATEMENT_COMPLETION_UNKNOWN DEADLOCK_DETECTED SYNTAX_ERROR_OR_ACCESS_RULE_VIOLATION SYNTAX_ERROR INSUFFICIENT_PRIVILEGE CANNOT_COERCE GROUPING_ERROR WINDOWING_ERROR INVALID_RECURSION INVALID_FOREIGN_KEY INVALID_NAME NAME_TOO_LONG RESERVED_NAME DATATYPE_MISMATCH INDETERMINATE_DATATYPE COLLATION_MISMATCH INDETERMINATE_COLLATION WRONG_OBJECT_TYPE GENERATED_ALWAYS UNDEFINED_COLUMN UNDEFINED_FUNCTION UNDEFINED_TABLE UNDEFINED_PARAMETER UNDEFINED_OBJECT DUPLICATE_COLUMN DUPLICATE_CURSOR DUPLICATE_DATABASE DUPLICATE_FUNCTION DUPLICATE_PREPARED_STATEMENT DUPLICATE_SCHEMA DUPLICATE_TABLE DUPLICATE_ALIAS DUPLICATE_OBJECT AMBIGUOUS_COLUMN AMBIGUOUS_FUNCTION AMBIGUOUS_PARAMETER AMBIGUOUS_ALIAS INVALID_COLUMN_REFERENCE INVALID_COLUMN_DEFINITION INVALID_CURSOR_DEFINITION INVALID_DATABASE_DEFINITION INVALID_FUNCTION_DEFINITION INVALID_PREPARED_STATEMENT_DEFINITION INVALID_SCHEMA_DEFINITION INVALID_TABLE_DEFINITION INVALID_OBJECT_DEFINITION WITH_CHECK_OPTION_VIOLATION INSUFFICIENT_RESOURCES DISK_FULL OUT_OF_MEMORY TOO_MANY_CONNECTIONS CONFIGURATION_LIMIT_EXCEEDED PROGRAM_LIMIT_EXCEEDED STATEMENT_TOO_COMPLEX TOO_MANY_COLUMNS TOO_MANY_ARGUMENTS OBJECT_NOT_IN_PREREQUISITE_STATE OBJECT_IN_USE CANT_CHANGE_RUNTIME_PARAM LOCK_NOT_AVAILABLE OPERATOR_INTERVENTION QUERY_CANCELED ADMIN_SHUTDOWN CRASH_SHUTDOWN CANNOT_CONNECT_NOW DATABASE_DROPPED SYSTEM_ERROR IO_ERROR UNDEFINED_FILE DUPLICATE_FILE SNAPSHOT_TOO_OLD CONFIG_FILE_ERROR LOCK_FILE_EXISTS FDW_ERROR FDW_COLUMN_NAME_NOT_FOUND FDW_DYNAMIC_PARAMETER_VALUE_NEEDED FDW_FUNCTION_SEQUENCE_ERROR FDW_INCONSISTENT_DESCRIPTOR_INFORMATION FDW_INVALID_ATTRIBUTE_VALUE FDW_INVALID_COLUMN_NAME FDW_INVALID_COLUMN_NUMBER FDW_INVALID_DATA_TYPE FDW_INVALID_DATA_TYPE_DESCRIPTORS FDW_INVALID_DESCRIPTOR_FIELD_IDENTIFIER FDW_INVALID_HANDLE FDW_INVALID_OPTION_INDEX FDW_INVALID_OPTION_NAME FDW_INVALID_STRING_LENGTH_OR_BUFFER_LENGTH FDW_INVALID_STRING_FORMAT FDW_INVALID_USE_OF_NULL_POINTER FDW_TOO_MANY_HANDLES FDW_OUT_OF_MEMORY FDW_NO_SCHEMAS FDW_OPTION_NAME_NOT_FOUND FDW_REPLY_HANDLE FDW_SCHEMA_NOT_FOUND FDW_TABLE_NOT_FOUND FDW_UNABLE_TO_CREATE_EXECUTION FDW_UNABLE_TO_CREATE_REPLY FDW_UNABLE_TO_ESTABLISH_CONNECTION PLPGSQL_ERROR RAISE_EXCEPTION NO_DATA_FOUND TOO_MANY_ROWS ASSERT_FAILURE INTERNAL_ERROR DATA_CORRUPTED INDEX_CORRUPTED "
},illegal:/:==|\W\s*\(\*|(^|\s)\$[a-z]|\{\{|[a-z]:\s*$|\.\.\.|TO:|DO:/,
contains:[{className:"keyword",variants:[{begin:/\bTEXT\s*SEARCH\b/},{
begin:/\b(PRIMARY|FOREIGN|FOR(\s+NO)?)\s+KEY\b/},{
begin:/\bPARALLEL\s+(UNSAFE|RESTRICTED|SAFE)\b/},{
begin:/\bSTORAGE\s+(PLAIN|EXTERNAL|EXTENDED|MAIN)\b/},{
begin:/\bMATCH\s+(FULL|PARTIAL|SIMPLE)\b/},{begin:/\bNULLS\s+(FIRST|LAST)\b/},{
begin:/\bEVENT\s+TRIGGER\b/},{begin:/\b(MAPPING|OR)\s+REPLACE\b/},{
begin:/\b(FROM|TO)\s+(PROGRAM|STDIN|STDOUT)\b/},{
begin:/\b(SHARE|EXCLUSIVE)\s+MODE\b/},{
begin:/\b(LEFT|RIGHT)\s+(OUTER\s+)?JOIN\b/},{
begin:/\b(FETCH|MOVE)\s+(NEXT|PRIOR|FIRST|LAST|ABSOLUTE|RELATIVE|FORWARD|BACKWARD)\b/
},{begin:/\bPRESERVE\s+ROWS\b/},{begin:/\bDISCARD\s+PLANS\b/},{
begin:/\bREFERENCING\s+(OLD|NEW)\b/},{begin:/\bSKIP\s+LOCKED\b/},{
begin:/\bGROUPING\s+SETS\b/},{
begin:/\b(BINARY|INSENSITIVE|SCROLL|NO\s+SCROLL)\s+(CURSOR|FOR)\b/},{
begin:/\b(WITH|WITHOUT)\s+HOLD\b/},{
begin:/\bWITH\s+(CASCADED|LOCAL)\s+CHECK\s+OPTION\b/},{
begin:/\bEXCLUDE\s+(TIES|NO\s+OTHERS)\b/},{
begin:/\bFORMAT\s+(TEXT|XML|JSON|YAML)\b/},{
begin:/\bSET\s+((SESSION|LOCAL)\s+)?NAMES\b/},{begin:/\bIS\s+(NOT\s+)?UNKNOWN\b/
},{begin:/\bSECURITY\s+LABEL\b/},{begin:/\bSTANDALONE\s+(YES|NO|NO\s+VALUE)\b/
},{begin:/\bWITH\s+(NO\s+)?DATA\b/},{begin:/\b(FOREIGN|SET)\s+DATA\b/},{
begin:/\bSET\s+(CATALOG|CONSTRAINTS)\b/},{begin:/\b(WITH|FOR)\s+ORDINALITY\b/},{
begin:/\bIS\s+(NOT\s+)?DOCUMENT\b/},{
begin:/\bXML\s+OPTION\s+(DOCUMENT|CONTENT)\b/},{
begin:/\b(STRIP|PRESERVE)\s+WHITESPACE\b/},{
begin:/\bNO\s+(ACTION|MAXVALUE|MINVALUE)\b/},{
begin:/\bPARTITION\s+BY\s+(RANGE|LIST|HASH)\b/},{begin:/\bAT\s+TIME\s+ZONE\b/},{
begin:/\bGRANTED\s+BY\b/},{begin:/\bRETURN\s+(QUERY|NEXT)\b/},{
begin:/\b(ATTACH|DETACH)\s+PARTITION\b/},{
begin:/\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/},{
begin:/\b(INCLUDING|EXCLUDING)\s+(COMMENTS|CONSTRAINTS|DEFAULTS|IDENTITY|INDEXES|STATISTICS|STORAGE|ALL)\b/
},{begin:/\bAS\s+(ASSIGNMENT|IMPLICIT|PERMISSIVE|RESTRICTIVE|ENUM|RANGE)\b/}]},{
begin:/\b(FORMAT|FAMILY|VERSION)\s*\(/},{begin:/\bINCLUDE\s*\(/,
keywords:"INCLUDE"},{begin:/\bRANGE(?!\s*(BETWEEN|UNBOUNDED|CURRENT|[-0-9]+))/
},{
begin:/\b(VERSION|OWNER|TEMPLATE|TABLESPACE|CONNECTION\s+LIMIT|PROCEDURE|RESTRICT|JOIN|PARSER|COPY|START|END|COLLATION|INPUT|ANALYZE|STORAGE|LIKE|DEFAULT|DELIMITER|ENCODING|COLUMN|CONSTRAINT|TABLE|SCHEMA)\s*=/
},{begin:/\b(PG_\w+?|HAS_[A-Z_]+_PRIVILEGE)\b/,relevance:10},{
begin:/\bEXTRACT\s*\(/,end:/\bFROM\b/,returnEnd:!0,keywords:{
type:"CENTURY DAY DECADE DOW DOY EPOCH HOUR ISODOW ISOYEAR MICROSECONDS MILLENNIUM MILLISECONDS MINUTE MONTH QUARTER SECOND TIMEZONE TIMEZONE_HOUR TIMEZONE_MINUTE WEEK YEAR"
}},{begin:/\b(XMLELEMENT|XMLPI)\s*\(\s*NAME/,keywords:{keyword:"NAME"}},{
begin:/\b(XMLPARSE|XMLSERIALIZE)\s*\(\s*(DOCUMENT|CONTENT)/,keywords:{
keyword:"DOCUMENT CONTENT"}},{beginKeywords:"CACHE INCREMENT MAXVALUE MINVALUE",
end:E.C_NUMBER_RE,returnEnd:!0,keywords:"BY CACHE INCREMENT MAXVALUE MINVALUE"
},{className:"type",begin:/\b(WITH|WITHOUT)\s+TIME\s+ZONE\b/},{className:"type",
begin:/\bINTERVAL\s+(YEAR|MONTH|DAY|HOUR|MINUTE|SECOND)(\s+TO\s+(MONTH|HOUR|MINUTE|SECOND))?\b/
},{
begin:/\bRETURNS\s+(LANGUAGE_HANDLER|TRIGGER|EVENT_TRIGGER|FDW_HANDLER|INDEX_AM_HANDLER|TSM_HANDLER)\b/,
keywords:{keyword:"RETURNS",
type:"LANGUAGE_HANDLER TRIGGER EVENT_TRIGGER FDW_HANDLER INDEX_AM_HANDLER TSM_HANDLER"
}},{begin:"\\b("+I+")\\s*\\("},{begin:"\\.("+R+")\\b"},{
begin:"\\b("+R+")\\s+PATH\\b",keywords:{keyword:"PATH",
type:A.replace("PATH ","")}},{className:"type",begin:"\\b("+R+")\\b"},{
className:"string",begin:"'",end:"'",contains:[{begin:"''"}]},{
className:"string",begin:"(e|E|u&|U&)'",end:"'",contains:[{begin:"\\\\."}],
relevance:10},E.END_SAME_AS_BEGIN({begin:N,end:N,contains:[{
subLanguage:["pgsql","perl","python","tcl","r","lua","java","php","ruby","bash","scheme","xml","json"],
endsWithParent:!0}]}),{begin:'"',end:'"',contains:[{begin:'""'}]
},E.C_NUMBER_MODE,E.C_BLOCK_COMMENT_MODE,T,{className:"meta",variants:[{
begin:"%(ROW)?TYPE",relevance:10},{begin:"\\$\\d+"},{begin:"^#\\w",end:"$"}]},{
className:"symbol",begin:"<<\\s*[a-zA-Z_][a-zA-Z_0-9$]*\\s*>>",relevance:10}]}}
})();hljs.registerLanguage("pgsql",E)})();
