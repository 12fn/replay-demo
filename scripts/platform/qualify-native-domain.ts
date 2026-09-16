import fs from 'node:fs';import {operatorClient,binding} from './operator-client';import {KamiwazaClient} from '../../src/platform';
const op=await operatorClient();try{const client=op.resolved.platformClient as KamiwazaClient;const ontology='f6e5e895-5673-40d2-a34b-0bf4343f362f',group=binding.workroom.id;
 const graph=await client.request<any>({method:'GET',path:`/context/ontologies/${ontology}/workrooms/${group}/subgraph`,query:{max_nodes:30,max_edges:40}});
 const search=await client.searchOntology(ontology,{query:'How does a newer source report replace an earlier estimate?',group_ids:[group],max_results:5},{workroomId:group});
 const proof={at:new Date().toISOString(),workroomId:group,ontologyId:ontology,graph:{receipt:graph.receipt,data:graph.data},search:{receipt:search.receipt,data:search.data}};fs.writeFileSync('evidence/platform/native-domain-qualification.json',JSON.stringify(proof,null,2));console.log(JSON.stringify({graphStatus:graph.receipt.status,graphKeys:Object.keys(graph.data),searchStatus:search.receipt.status,facts:search.data.facts,searchReceipt:search.receipt.requestId}));
}finally{op.sessions.close();}
