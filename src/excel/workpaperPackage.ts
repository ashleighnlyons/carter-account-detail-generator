import {CFB,utils} from 'xlsx';
import {GenerationError} from '../output/generationEligibility';
import {assertGenerationCounts,integrityFailure} from '../output/generationIntegrity';
import type {GenerationCounts} from '../output/generationIntegrity';

type StyleRole='title'|'header'|'boxedHeader'|'section'|'label'|'note'|'warning'|'error'|'link'|'memo'|'success';
export interface NativeTable {readonly name:string;readonly header:number;readonly count:number;readonly labels:readonly string[];}
export interface SheetPresentation {
  readonly name:string;readonly rows:number;readonly columns:number;
  readonly titleRows:readonly number[];readonly sectionRows:readonly number[];readonly headerRows:readonly number[];
  readonly warningRows:readonly number[];readonly noteRows:readonly number[];readonly totalRows:readonly number[];
  readonly cellStyles:Readonly<Record<string,StyleRole>>;readonly tables:readonly NativeTable[];
  readonly freezeRows:number;readonly freezeColumns:number;readonly printHeader:number;readonly printColumns:number;
  readonly accounts?:{readonly start:number;readonly count:number};readonly transactions?:{readonly start:number;readonly count:number};
  readonly representedAccounts?:number;readonly transactionRequiredColumns?:readonly number[];readonly memoColumns?:readonly string[];
  readonly transitionRows?:readonly number[];
  readonly summaryBoxRows?:readonly number[];
  readonly merges?:readonly string[];
}
interface Container {FullPaths:string[];FileIndex:{name:string;content:Uint8Array;size:number}[];}
const zip=CFB as {read:(bytes:Uint8Array,options:{type:'array'})=>Container;write:(value:Container,options:{type:'array';fileType:'zip';compression:boolean})=>number[]|Uint8Array;utils:{cfb_add:(value:Container,path:string,bytes:Uint8Array)=>unknown}};
const decoder=new TextDecoder(),encoder=new TextEncoder();
export const xmlEscape=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;').replaceAll('\n','&#10;').replaceAll('\r','&#13;').replaceAll('\t','&#9;');
function readPart(container:Container,path:string){const index=container.FullPaths.indexOf(`Root Entry/${path}`);if(index<0)integrityFailure();return decoder.decode(container.FileIndex[index].content);}
function writePart(container:Container,path:string,text:string){
  const bytes=encoder.encode(text),index=container.FullPaths.indexOf(`Root Entry/${path}`);
  // CFB add with a relative path can append a duplicate ZIP entry. Replace existing
  // parts directly; add only new parts, using CFB's absolute lookup convention.
  if(index>=0){container.FileIndex[index].content=bytes;container.FileIndex[index].size=bytes.length;}
  else zip.utils.cfb_add(container,`/${path}`,bytes);
}

function styleSheet(xml:string){
  const fonts=[
    '<font><sz val="10"/><color rgb="FF000000"/><name val="Arial"/></font>',
    '<font><b/><sz val="10"/><color rgb="FF000000"/><name val="Arial"/></font>',
    '<font><b/><sz val="14"/><color rgb="FF000000"/><name val="Arial"/></font>',
    '<font><i/><sz val="10"/><color rgb="FF000000"/><name val="Arial"/></font>',
  ];
  xml=xml.replace(/<fonts\b[^>]*>[\s\S]*?<\/fonts>/,`<fonts count="${fonts.length}">${fonts.join('')}</fonts>`);
  xml=xml.replace(/<fills\b[^>]*>[\s\S]*?<\/fills>/,'<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0F2F3"/><bgColor indexed="64"/></patternFill></fill></fills>');
  xml=xml.replace(/<borders\b[^>]*>[\s\S]*?<\/borders>/,'<borders count="4"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFB7B7B7"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FFBCC4CA"/></top><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFBFC6CA"/></left><right style="thin"><color rgb="FFBFC6CA"/></right><top style="thin"><color rgb="FFBFC6CA"/></top><bottom style="thin"><color rgb="FFBFC6CA"/></bottom><diagonal/></border></borders>');
  const match=/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);if(!match)integrityFailure();
  const originals=match[1].match(/<xf\b[^>]*(?:\/>|>[\s\S]*?<\/xf>)/g)??[];if(!originals.length)integrityFailure();
  const styles=originals.map(xf=>{const format=/numFmtId="(\d+)"/.exec(xf)?.[1]??'0';return `<xf numFmtId="${format}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="${format==='0'?'left':'right'}"/></xf>`;});
  const roles={} as Record<StyleRole,number>,totalStyles:Record<number,number>={},transitionStyles:Record<number,number>={},summaryBoxStyles:Record<number,number>={};
  function add(role:StyleRole,font:number,border:number,wrap=false,center=false,fill=0){roles[role]=styles.length;styles.push(`<xf numFmtId="0" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"${wrap?' wrapText="1"':''} horizontal="${center?'center':'left'}"/></xf>`);}
  add('title',2,0);add('header',1,1,true,true,2);add('boxedHeader',1,3,true,false,2);add('section',1,1);add('label',1,0,true);add('note',3,0,true);add('warning',0,0,true);add('error',1,0,true);add('link',0,0);add('memo',0,0,true);add('success',0,0);
  originals.forEach((xf,id)=>{const format=/numFmtId="(\d+)"/.exec(xf)?.[1]??'0';totalStyles[id]=styles.length;styles.push(`<xf numFmtId="${format}" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`);transitionStyles[id]=styles.length;styles.push(`<xf numFmtId="${format}" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`);summaryBoxStyles[id]=styles.length;styles.push(`<xf numFmtId="${format}" fontId="0" fillId="0" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" horizontal="${format==='0'?'left':'right'}"/></xf>`);});
  xml=xml.replace(match[0],`<cellXfs count="${styles.length}">${styles.join('')}</cellXfs>`);
  return {xml,roles,totalStyles,transitionStyles,summaryBoxStyles};
}
/** Verify physical emitted rows/cells, independent of loop counters, before download. */
export function verifyEmittedPopulation(xml:string,p:SheetPresentation):{accounts:number;transactions:number} {
  let accounts=0,transactions=0;const seen=new Set<number>();
  for(const match of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)){
    const row=Number(/\br="(\d+)"/.exec(match[1])?.[1]),content=match[2];
    if(!Number.isSafeInteger(row)||row<1||row>p.rows||seen.has(row))integrityFailure();seen.add(row);
    if(p.accounts&&row>=p.accounts.start&&row<p.accounts.start+p.accounts.count){if(!content.includes(`<c r="A${row}"`))integrityFailure();accounts++;}
    if(p.transactions&&row>=p.transactions.start&&row<p.transactions.start+p.transactions.count){
      const required=(p.transactionRequiredColumns??[0,1,12,13,14]).map(utils.encode_col);
      if(required.some(c=>!content.includes(`<c r="${c}${row}"`)))integrityFailure();transactions++;
    }
  }
  if(accounts!==(p.accounts?.count??0)||transactions!==(p.transactions?.count??0))integrityFailure();
  for(const table of p.tables??[])for(let row=table.header;row<=table.header+table.count;row++)if(!seen.has(row))integrityFailure();
  return {accounts,transactions};
}
function tableXml(table:NativeTable,id:number){
  const ref=`A${table.header}:${utils.encode_col(table.labels.length-1)}${table.header+table.count}`;
  if(!table.labels.length||new Set(table.labels.map(n=>n.toLowerCase())).size!==table.labels.length)integrityFailure();
  if(table.labels.some(n=>!n||n.length>255))throw new GenerationError('A source column heading exceeds Excel’s table-heading limit. Shorten the heading in a working copy of the export.');
  if(table.labels.some(n=>/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(n)))throw new GenerationError('A source column heading contains unsupported control characters. Obtain a fresh Excel export.');
  return {ref,xml:`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${id}" name="${table.name}" displayName="${table.name}" ref="${ref}" totalsRowShown="0"><autoFilter ref="${ref}"/><tableColumns count="${table.labels.length}">${table.labels.map((name,i)=>`<tableColumn id="${i+1}" name="${xmlEscape(name)}"/>`).join('')}</tableColumns><tableStyleInfo name="TableStyleLight1" showFirstColumn="0" showLastColumn="0" showRowStripes="0" showColumnStripes="0"/></table>`};
}
/** Adds native Excel presentation to our own values-only package, never to source files. */
export function finishWorkpaperPackage(bytes:ArrayBuffer,presentations:readonly SheetPresentation[],expected:GenerationCounts):ArrayBuffer {
  const container=zip.read(new Uint8Array(bytes),{type:'array'}),styles=styleSheet(readPart(container,'xl/styles.xml'));
  writePart(container,'xl/styles.xml',styles.xml);
  const written={sheets:presentations.length,leadcodes:presentations.length-1,accounts:0,transactions:0};
  let tableId=0,types=readPart(container,'[Content_Types].xml');const printNames:string[]=[];
  for(const [index,p] of presentations.entries()){
    const path=`xl/worksheets/sheet${index+1}.xml`;let xml=readPart(container,path);
    const emitted=verifyEmittedPopulation(xml,p);written.accounts+=emitted.accounts+(p.representedAccounts??0);written.transactions+=emitted.transactions;
    const titles=new Set(p.titleRows),headers=new Set(p.headerRows),sections=new Set(p.sectionRows),warnings=new Set(p.warningRows),notes=new Set(p.noteRows),totals=new Set(p.totalRows),transitions=new Set(p.transitionRows??[]),summaryBox=new Set(p.summaryBoxRows??[]);
    xml=xml.replace(/<c r="([A-Z]+)(\d+)"([^>]*)>/g,(original,col:string,rowText:string,attrs:string)=>{
      const row=Number(rowText),address=col+rowText;let role:StyleRole|undefined;
      if(headers.has(row))role='header';else if(titles.has(row))role='title';else if(sections.has(row))role='section';else if(warnings.has(row))role='warning';else if(notes.has(row))role='note';
      role=p.cellStyles[address]??role;
      const memo=!role&&p.transactions&&row>=p.transactions.start&&(p.memoColumns??['C','G','H']).includes(col);
      if(memo&&!transitions.has(row))role='memo';
      const old=Number(/\bs="(\d+)"/.exec(attrs)?.[1]??0),style=summaryBox.has(row)?headers.has(row)?styles.roles.boxedHeader:styles.summaryBoxStyles[old]:role?styles.roles[role]:totals.has(row)?styles.totalStyles[old]:transitions.has(row)?styles.transitionStyles[old]:undefined;
      return style===undefined?original:`<c r="${address}"${attrs.replace(/\s+s="\d+"/,'')} s="${style}">`;
    });
    const topLeft=`${utils.encode_col(p.freezeColumns)}${p.freezeRows+1}`;
    const pane=p.freezeRows||p.freezeColumns?`<pane${p.freezeColumns?` xSplit="${p.freezeColumns}"`:''}${p.freezeRows?` ySplit="${p.freezeRows}"`:''} topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="${topLeft}" sqref="${topLeft}"/>`:'';
    xml=xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/,`<sheetViews><sheetView workbookViewId="0" showGridLines="1" zoomScale="100">${pane}</sheetView></sheetViews>`);
    xml=xml.replace('</sheetViews>','</sheetViews><sheetFormatPr defaultRowHeight="18"/>');
    if(p.merges?.length)xml=xml.replace('</sheetData>',`</sheetData><mergeCells count="${p.merges.length}">${p.merges.map(ref=>`<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`);
    const sheetName=xmlEscape(p.name.replaceAll("'","''"));
    const printTitleParts=[...(p.freezeColumns?[`'${sheetName}'!$A:$${utils.encode_col(p.freezeColumns-1)}`]:[]),...(p.printHeader?[`'${sheetName}'!$${p.printHeader}:$${p.printHeader}`]:[])];
    if(printTitleParts.length)printNames.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${index}">${printTitleParts.join(',')}</definedName>`);
    printNames.push(`<definedName name="_xlnm.Print_Area" localSheetId="${index}">'${sheetName}'!$A$1:$${utils.encode_col(p.printColumns-1)}$${p.rows}</definedName>`);
    const printing='<printOptions horizontalCentered="0"/><pageMargins left="0.25" right="0.25" top="0.45" bottom="0.45" header="0.2" footer="0.2"/><pageSetup paperSize="1" orientation="landscape" scale="100"/><headerFooter><oddHeader>&amp;L&amp;"Arial,Bold"Carter &amp;&amp; Company&amp;R&amp;A</oddHeader><oddFooter>&amp;LAccount Detail Workbook&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter>';
    // Native table filters own their ranges; remove overlapping worksheet-level filters.
    xml=xml.replace(/<autoFilter\b[^>]*(?:\/>|>[\s\S]*?<\/autoFilter>)/g,'');
    let parts='';
    for(const table of p.tables){const id=++tableId,definition=tableXml(table,id),relationship=`rIdADGTable${id}`;
      writePart(container,`xl/tables/table${id}.xml`,definition.xml);types=types.replace('</Types>',`<Override PartName="/xl/tables/table${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>`);
      const relPath=`xl/worksheets/_rels/sheet${index+1}.xml.rels`,existing=container.FullPaths.includes(`Root Entry/${relPath}`)?readPart(container,relPath):'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      writePart(container,relPath,existing.replace('</Relationships>',`<Relationship Id="${relationship}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${id}.xml"/></Relationships>`));parts+=`<tablePart r:id="${relationship}"/>`;
    }
    // Printing precedes ignoredErrors; native table parts follow it (SpreadsheetML element order).
    if(xml.includes('<ignoredErrors>'))xml=xml.replace('<ignoredErrors>',printing+'<ignoredErrors>');else xml=xml.replace('</worksheet>',printing+'</worksheet>');
    if(parts)xml=xml.replace('</worksheet>',`<tableParts count="${p.tables.length}">${parts}</tableParts></worksheet>`);
    writePart(container,path,xml);
  }
  assertGenerationCounts(expected,written);
  if(new Set(container.FullPaths).size!==container.FullPaths.length)integrityFailure();
  let workbook=readPart(container,'xl/workbook.xml');
  if((workbook.match(/<sheet\b/g)??[]).length!==expected.sheets)integrityFailure();
  if(workbook.includes('</definedNames>'))workbook=workbook.replace('</definedNames>',printNames.join('')+'</definedNames>');
  else workbook=workbook.replace('</sheets>',`</sheets><definedNames>${printNames.join('')}</definedNames>`);
  writePart(container,'xl/workbook.xml',workbook);writePart(container,'[Content_Types].xml',types);
  return new Uint8Array(zip.write(container,{type:'array',fileType:'zip',compression:true})).buffer;
}
