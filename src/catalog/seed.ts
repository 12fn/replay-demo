/**
 * Deterministic authored preset catalog. Everything here is hand-authored reference data:
 * personas are fictional demo presets (not users, not inferred skill, not modeled on real people),
 * case timelines are illustrative examples (not engine replays or recorded games), and all forces,
 * assets and organizations are fictional game entities. Historical cards only point to public
 * sources supplied by CATALOG_SOURCES and reuse their original summaries verbatim.
 * No randomness, wall clock, file, network, model or native calls.
 */
import type {CatalogAor,CatalogAorId,CatalogBundle,CatalogLink,CatalogRecord,CatalogRole,CatalogSource} from './types';
import {CATALOG_SOURCES} from './sources';

export const PRESET_CATALOG_VERSION='preset-catalog/1';
export const PRESET_CATALOG_SEED='authored-deterministic/preset-catalog/1';
export const PRESET_CATALOG_NOTICE='Authored reference catalog. Personas, organizations, assets, Red profiles, reports and case timelines are fictional synthetic examples: not authenticated users, not real people, not real forces, not engine replays and not assessments of anyone. Historical cards link to public sources and repeat only the source-provided summary.';

const ROLES:CatalogRole[]=['commander','intelligence','instructor'];
const ALL_ROLES:CatalogRole[]=[...ROLES];
export const DECISION_DEADLINE_OFFSET=18;

type LessonKey='source-lineage'|'corroboration-threshold'|'reserve-allocation'|'communication-delay'|'weather-logistics-window'|'confidence-calibration';
type BehaviorKey='derivative-double-count-corrected'|'waits-for-corroboration'|'premature-commitment'|'conservative-hold'|'evidence-update-delegation'|'calibration';
type Variant='late-correction'|'early-corroboration';
type Nature='position'|'count';
type Rating<T extends string>={rating:T;text:string};
type OutcomeRating='favorable'|'mixed'|'costly';
type ReasoningRating='supported'|'partly-supported'|'unsupported';

const LESSON_KEYS:LessonKey[]=['source-lineage','corroboration-threshold','reserve-allocation','communication-delay','weather-logistics-window','confidence-calibration'];

/** Contrast pairs: same lesson and decision deadline; the late-correction case has a long relay delay, the early case a short one. */
const CONTRAST_PAIRS:Array<{lesson:LessonKey;late:BehaviorKey;early:BehaviorKey}>=[
  {lesson:'corroboration-threshold',late:'premature-commitment',early:'waits-for-corroboration'},
  {lesson:'source-lineage',late:'derivative-double-count-corrected',early:'calibration'},
  {lesson:'reserve-allocation',late:'conservative-hold',early:'evidence-update-delegation'},
  {lesson:'communication-delay',late:'evidence-update-delegation',early:'premature-commitment'},
  {lesson:'weather-logistics-window',late:'calibration',early:'conservative-hold'},
  {lesson:'confidence-calibration',late:'waits-for-corroboration',early:'derivative-double-count-corrected'},
];
const BEHAVIOR_ORDER:BehaviorKey[]=['derivative-double-count-corrected','waits-for-corroboration','premature-commitment','conservative-hold','evidence-update-delegation','calibration'];
const PRIMARY_LESSON:Record<BehaviorKey,LessonKey>={
  'derivative-double-count-corrected':'source-lineage','waits-for-corroboration':'corroboration-threshold','premature-commitment':'weather-logistics-window',
  'conservative-hold':'reserve-allocation','evidence-update-delegation':'communication-delay','calibration':'confidence-calibration',
};

interface AssetSpec {key:string;title:string;category:'patrol'|'sensor'|'communications'|'logistics'|'weather';reserve:boolean;enduranceTicks:number;summary:string;constraint:string;tags:string[]}
interface GlossarySpec {key:string;term:string;definition:string;tags:string[];sourceIds?:string[]}
interface OrgSpec {key:string;title:string;summary:string}
interface AorSpec {
  aor:Omit<CatalogAor,'sourceIds'>&{sourceIds:string[]};
  historicalSourceId:string;historicalFraming:string;historicalLessons:LessonKey[];
  /** Count corrections are only authored for group subjects; single-vessel subjects always get position corrections. */
  sectors:string[];subjects:Array<{full:string;short:string;group:boolean}>;countUnit:string;corroborationAssetKey:string;
  weather:string[];transport:string[];comms:string[];
  sources:{primary:string;derivative:string;conflict:string;logistics:string;correction:string;corroboration:string};
  assets:AssetSpec[];glossary:GlossarySpec[];
  orgs:Record<CatalogRole,OrgSpec>;
  red:{key:string;title:string;summary:string;tendencies:string[];counters:string[]};
  lessons:Record<LessonKey,{title:string;note:string;glossary:string[]}>;
  names:string[];
}

const AORS:AorSpec[]=[
  {
    aor:{id:'taiwan',name:'Taiwan Strait',theater:'Western Pacific maritime game setting',playableScenarioId:'taiwan-strait/1',
      summary:'Playable setting for the taiwan-strait/1 relay contest. Fictional Blue and Red cells allocate patrol, relay and logistics assets across strait crossing lanes while monsoon swell, typhoon rainbands and fog constrain movement. All forces are fictional game entities.',
      focus:['maritime resource allocation','relay network contest','evidence validation','communication delay','weather and logistics constraints','decisions under uncertainty'],
      sourceIds:['natural-earth-terms','navy-midway-1942']},
    historicalSourceId:'navy-midway-1942',
    historicalFraming:'Pacific maritime reference for discussion. It is not a Taiwan Strait event and is not reenacted in this setting.',
    historicalLessons:['communication-delay','confidence-calibration'],
    sectors:['Sector Lantern','Sector Jade Shoal','Sector Harrow Bank','Sector Kite Channel','Sector Pearl Relay','Sector Driftline'],
    subjects:[
      {full:'a small-craft group loitering near a relay buoy',short:'small-craft group at a relay buoy',group:true},
      {full:'a freighter drifting across the northbound crossing lane',short:'drifting freighter in the crossing lane',group:false},
      {full:'an unscheduled survey vessel near the relay cable marker',short:'survey vessel at the cable marker',group:false},
      {full:'dark returns mixed into fishing-fleet clutter',short:'returns in fishing-fleet clutter',group:true},
      {full:'a disabled coaster reported under tow',short:'coaster under tow',group:false},
      {full:'fast boats circling a relay node',short:'fast boats at a relay node',group:true},
    ],
    countUnit:'small craft',corroborationAssetKey:'lantern-2',
    weather:['northeast monsoon swell raising the sea state','a typhoon outer rainband closing the air window','dense morning fog over the crossing lanes'],
    transport:['fuel barge Tern leaving harbor two ticks late','the relay repair tender tied up with a buoy swap','the southern pier ferry slot slipping by three ticks'],
    comms:['the relay buoy line dropping packets','the shore net queued behind priority traffic'],
    sources:{primary:'Coastal radar mast 3',derivative:'Harbor liaison bulletin',conflict:'Weather picket boat Gull',logistics:'Harbor logistics board',correction:'Coastal radar mast 3, revised track',corroboration:'Patrol aircraft Lantern-2'},
    assets:[
      {key:'heron-cutter',title:'Demo patrol cutter Heron',category:'patrol',reserve:true,enduranceTicks:40,summary:'Fictional reserve cutter held for relay-node response.',constraint:'Transit slows when monsoon swell exceeds a moderate sea state.',tags:['reserve','transport','weather']},
      {key:'tidewater-cutter',title:'Demo patrol cutter Tidewater',category:'patrol',reserve:true,enduranceTicks:36,summary:'Fictional second cutter; shares the fuel barge with Heron.',constraint:'Must refuel from barge Tern before a second long transit.',tags:['reserve','transport']},
      {key:'lantern-2',title:'Demo patrol aircraft Lantern-2',category:'patrol',reserve:true,enduranceTicks:12,summary:'Fictional short-endurance aircraft used for quick looks and as a fast reserve.',constraint:'Grounded while a typhoon rainband covers the air window.',tags:['reserve','weather','corroboration']},
      {key:'radar-mast-3',title:'Demo coastal radar mast 3',category:'sensor',reserve:false,enduranceTicks:0,summary:'Fictional shore radar that originates many first contact reports.',constraint:'Fishing-fleet clutter lowers track quality and inflates counts.',tags:['provenance','confidence']},
      {key:'relay-buoy-line',title:'Demo relay buoy line North',category:'communications',reserve:false,enduranceTicks:0,summary:'Fictional relay chain that carries reports to the watch.',constraint:'Drops packets in high swell, adding relay delay.',tags:['communication','weather']},
      {key:'gull-picket',title:'Demo weather picket boat Gull',category:'weather',reserve:false,enduranceTicks:30,summary:'Fictional picket that reports weather and occasional visual sightings.',constraint:'Visual sightings are unreliable in fog.',tags:['weather','corroboration']},
      {key:'tern-fuel-barge',title:'Demo fuel barge Tern',category:'logistics',reserve:false,enduranceTicks:60,summary:'Fictional barge that refuels both cutters.',constraint:'One refuel per turnaround; late departures cascade.',tags:['transport']},
      {key:'mend-repair-tender',title:'Demo relay repair tender Mend',category:'logistics',reserve:false,enduranceTicks:48,summary:'Fictional tender that swaps failed relay buoys.',constraint:'Cannot swap buoys and tow at the same time.',tags:['transport','communication']},
      {key:'mariner-ferry',title:'Demo supply ferry Mariner',category:'logistics',reserve:false,enduranceTicks:50,summary:'Fictional ferry that carries spares to the island pier.',constraint:'Bound to scheduled pier slots.',tags:['transport']},
    ],
    glossary:[
      {key:'relay-contest',term:'Relay contest',definition:'The taiwan-strait/1 game objective: hold and restore fictional relay sites; the network score tallies held links.',tags:['communication']},
      {key:'crossing-lane',term:'Crossing lane',definition:'An authored game-grid lane where transits are counted; congestion here slows transport.',tags:['transport']},
      {key:'monsoon-swell',term:'Monsoon swell',definition:'Game weather condition that raises sea state and slows small hulls and cutters.',tags:['weather','transport']},
      {key:'typhoon-standby',term:'Typhoon standby',definition:'Game weather state in which aircraft are grounded and cutters stay near shelter until the rainband passes.',tags:['weather','reserve']},
      {key:'fog-window',term:'Fog window',definition:'Period when visual sightings are weak evidence and radar reports carry more of the picture.',tags:['weather','corroboration','confidence']},
      {key:'fishing-fleet-clutter',term:'Fishing-fleet clutter',definition:'Radar returns from many small boats that can hide or inflate a contact count.',tags:['confidence','provenance']},
      {key:'relay-lag',term:'Relay lag',definition:'Ticks between an observation and its arrival at the watch over the buoy line.',tags:['communication']},
      {key:'liaison-bulletin',term:'Liaison bulletin',definition:'A compiled harbor summary that restates earlier reports. It is derivative: it adds no independent observation.',tags:['provenance','corroboration']},
      {key:'revised-track',term:'Revised track',definition:'A correction from the same sensor that replaces an earlier plot; the earlier report is superseded.',tags:['source-change','provenance']},
      {key:'barge-turnaround',term:'Barge turnaround',definition:'Ticks for the fuel barge to refuel one cutter and return to station.',tags:['transport','reserve']},
      {key:'relay-reserve',term:'Relay reserve',definition:'Cutter or aircraft held back to answer a relay-node threat instead of patrolling.',tags:['reserve']},
      {key:'taiwan-strait-map-name',term:'Taiwan Strait (map name)',definition:'Marine area name used for the playable game map. The linked geographic data reference is context only; the game terrain is a separately pinned asset and its sectors are fictional.',tags:['provenance'],sourceIds:['natural-earth-terms']},
    ],
    orgs:{
      commander:{key:'strait-watch-cell',title:'Demo Strait Watch Cell',summary:'Fictional Blue watch cell that commits cutters and aircraft to relay sites.'},
      intelligence:{key:'relay-fusion-desk',title:'Demo Relay Fusion Desk',summary:'Fictional desk that grades radar, picket and liaison reports for the watch.'},
      instructor:{key:'strait-exercise-control',title:'Demo Strait Exercise Control',summary:'Fictional facilitator cell that adjudicates relay-contest injects and runs reviews.'},
    },
    red:{key:'tidewall',title:'Red Cell Tidewall (fictional)',summary:'Fictional game opponent for the relay contest. Authored play style only; not modeled on any real force.',
      tendencies:['Times moves to land inside Blue relay lag','Generates noisy traffic near relay buoys that invites double counting','Contests two relay sites so a single reserve cannot cover both'],
      counters:['Trace report lineage before counting sightings','Stage reserves between sites with named release triggers','Set report-back ticks that account for relay lag']},
    lessons:{
      'source-lineage':{title:'Tracing a liaison bulletin back to the radar log',note:'The harbor liaison bulletin often restates coastal radar mast 3; in clutter it can look like a second sighting.',glossary:['liaison-bulletin','fishing-fleet-clutter','revised-track']},
      'corroboration-threshold':{title:'How many lineages before moving a cutter',note:'A cutter sent to the wrong relay site cannot return before barge Tern completes its turnaround.',glossary:['relay-reserve','crossing-lane','liaison-bulletin']},
      'reserve-allocation':{title:'Keeping a relay reserve useful, not idle',note:'Two contested relay sites and one ready cutter make an unconditional hold as costly as a guess.',glossary:['relay-reserve','relay-contest','barge-turnaround']},
      'communication-delay':{title:'Deciding through buoy-line lag',note:'In high swell the buoy line drops packets, so the watch sees the strait several ticks late.',glossary:['relay-lag','monsoon-swell','revised-track']},
      'weather-logistics-window':{title:'Monsoon swell, barge timing and the move window',note:'Swell slows the cutters and a late fuel barge shortens how long they can stay on a relay site.',glossary:['monsoon-swell','typhoon-standby','barge-turnaround']},
      'confidence-calibration':{title:'Stating confidence on returns in fishing clutter',note:'Clutter makes counts unstable; ranges should widen before they narrow.',glossary:['fishing-fleet-clutter','fog-window','revised-track']},
    },
    names:['Rowan Vale','Juniper Hale','Ansel Marrow','Tamsin Reed','Corin Ashby','Lark Penrose','Odile Farrow','Bram Kestrel','Sable Quinlan','Idris Thorne','Wynn Calder','Maren Holt'],
  },
  {
    aor:{id:'caribbean',name:'Cuba and Caribbean',theater:'Caribbean maritime context setting',playableScenarioId:null,
      summary:'Context-only setting with no playable scenario. Fictional island-support cells manage patrol, seaplane and resupply assets across trade-wind waters, with scheduled courier reporting windows and tropical weather. A public historical reference is linked for discussion only.',
      focus:['maritime resource allocation','scheduled reporting windows','evidence validation','conflicting reports','tropical weather and resupply constraints','decisions under uncertainty'],
      sourceIds:['state-cuba-1962','natural-earth-terms']},
    historicalSourceId:'state-cuba-1962',
    historicalFraming:'Public historical reference for discussing decisions with incomplete and changing information. The fictional cay setting does not reenact it.',
    historicalLessons:['communication-delay','confidence-calibration'],
    sectors:['Sector Coral Gate','Sector Lumen Cay','Sector Tradewind Reach','Sector Mangrove Sound','Sector Pelican Bank','Sector Salt Key'],
    subjects:[
      {full:'a cargo vessel with an irregular position broadcast east of the cay',short:'cargo vessel with an irregular broadcast',group:false},
      {full:'a sailing yacht overdue at the resupply anchorage',short:'overdue yacht at the anchorage',group:false},
      {full:'small boats gathering at a cargo transfer outside harbor limits',short:'boats at an offshore cargo transfer',group:true},
      {full:'fishing launches scattered adrift after a squall',short:'launches adrift after a squall',group:true},
      {full:'an unlit vessel crossing the ferry route at night',short:'unlit vessel on the ferry route',group:false},
      {full:'reef-survey boats working outside their permitted box',short:'survey boats outside the permit box',group:true},
    ],
    countUnit:'boats',corroborationAssetKey:'pelican-1',
    weather:['tropical-wave squalls moving through','long hurricane-season swell at the harbor mouth','afternoon trade-wind chop limiting small boats'],
    transport:['the island resupply ferry waiting on a pier slot','fuel drums held at the cay dock until the squall passes','the seaplane tender short of spare parts'],
    comms:['the HF courier net opening only on scheduled windows','the harbor agent relaying messages by telephone chain'],
    sources:{primary:'Lumen Cay lookout post',derivative:'Port agent summary',conflict:'Ferry master of Brightline',logistics:'Cay dock supply log',correction:'Lumen Cay lookout post, revised log',corroboration:'Patrol seaplane Pelican-1'},
    assets:[
      {key:'pelican-1',title:'Demo patrol seaplane Pelican-1',category:'patrol',reserve:true,enduranceTicks:14,summary:'Fictional seaplane used for quick looks between cays.',constraint:'Cannot land or refuel afloat in swell above moderate.',tags:['reserve','weather','corroboration']},
      {key:'coral-launch',title:'Demo harbor patrol launch Coral',category:'patrol',reserve:true,enduranceTicks:20,summary:'Fictional fast launch kept at the main harbor.',constraint:'Limited to sheltered water in trade-wind chop.',tags:['reserve','weather']},
      {key:'tradewind-cutter',title:'Demo island cutter Tradewind',category:'patrol',reserve:true,enduranceTicks:44,summary:'Fictional long-endurance cutter that covers the outer cays.',constraint:'Slow to reposition; one long transit per resupply.',tags:['reserve','transport']},
      {key:'lumen-lookout',title:'Demo Lumen Cay lookout post',category:'sensor',reserve:false,enduranceTicks:0,summary:'Fictional hilltop lookout that originates most first sightings.',constraint:'Night and squall visibility are poor; one vantage point only.',tags:['provenance','confidence']},
      {key:'courier-net',title:'Demo HF courier net',category:'communications',reserve:false,enduranceTicks:0,summary:'Fictional radio net that passes reports on scheduled windows.',constraint:'Reports wait for the next window, adding fixed delay.',tags:['communication']},
      {key:'brightline-ferry',title:'Demo resupply ferry Brightline',category:'logistics',reserve:false,enduranceTicks:50,summary:'Fictional ferry whose master also radios sightings on the route.',constraint:'Bound to pier slots at each cay.',tags:['transport','corroboration']},
      {key:'cay-dock-fuel',title:'Demo cay dock fuel store',category:'logistics',reserve:false,enduranceTicks:0,summary:'Fictional drum fuel store for launches and the seaplane.',constraint:'Drums cannot be moved during squalls.',tags:['transport','weather']},
      {key:'frigatebird-tender',title:'Demo seaplane tender Frigatebird',category:'logistics',reserve:false,enduranceTicks:40,summary:'Fictional tender that supports Pelican-1 away from the harbor.',constraint:'Short of spares; one sortie turnaround at a time.',tags:['transport','reserve']},
      {key:'squall-buoy-4',title:'Demo tropical weather buoy Squall-4',category:'weather',reserve:false,enduranceTicks:0,summary:'Fictional buoy that reports wind and swell.',constraint:'Reports on the courier schedule like everything else.',tags:['weather','communication']},
    ],
    glossary:[
      {key:'courier-window',term:'Courier window',definition:'Scheduled slot when the HF courier net passes queued reports; between windows the watch hears nothing new.',tags:['communication']},
      {key:'trade-wind-chop',term:'Trade-wind chop',definition:'Afternoon sea condition in the game that confines launches to sheltered water.',tags:['weather','transport']},
      {key:'tropical-wave-squall',term:'Tropical-wave squall',definition:'Passing squall line that blinds lookouts and stops drum fuel handling for several ticks.',tags:['weather','confidence']},
      {key:'hurricane-season-hold',term:'Hurricane-season hold',definition:'Game rule that keeps the seaplane and small boats in harbor when swell passes a set level.',tags:['weather','reserve']},
      {key:'cay-lookout',term:'Cay lookout',definition:'Single elevated vantage point; its sightings are one lineage however many times they are repeated.',tags:['provenance','corroboration']},
      {key:'port-agent-summary',term:'Port agent summary',definition:'Compiled note from the harbor agent that restates lookout and ferry reports. Derivative, not independent.',tags:['provenance','corroboration']},
      {key:'revised-log',term:'Revised log',definition:'Lookout correction that replaces an earlier log entry; the earlier entry is superseded.',tags:['source-change','provenance']},
      {key:'pier-slot',term:'Pier slot',definition:'Scheduled berth time at a cay pier; missing one pushes resupply to the next slot.',tags:['transport']},
      {key:'drum-fuel',term:'Drum fuel',definition:'Fuel moved by hand in drums at the cay dock; slow and weather-limited.',tags:['transport','weather']},
      {key:'swell-landing-limit',term:'Swell landing limit',definition:'Sea state above which the seaplane cannot land to refuel or inspect.',tags:['weather','reserve']},
      {key:'sighting-flood',term:'Sighting flood',definition:'Burst of repeated sightings arriving in one courier window, many of them restating each other.',tags:['provenance','communication','confidence']},
      {key:'caribbean-sea-map-name',term:'Caribbean Sea (map name)',definition:'Marine area name used for the context setting. The linked geographic data reference is context only; the cays and sectors are fictional and no regional map is imported.',tags:['provenance'],sourceIds:['natural-earth-terms']},
    ],
    orgs:{
      commander:{key:'island-support-watch',title:'Demo Island Support Watch',summary:'Fictional watch that allocates the seaplane, launch and cutter across the cays.'},
      intelligence:{key:'cay-reporting-desk',title:'Demo Cay Reporting Desk',summary:'Fictional desk that sorts lookout, ferry and agent reports between courier windows.'},
      instructor:{key:'caribbean-seminar-control',title:'Demo Caribbean Seminar Control',summary:'Fictional seminar facilitators who run context-only discussion cases.'},
    },
    red:{key:'squall-line',title:'Red Cell Squall Line (fictional)',summary:'Fictional seminar opponent for context-only discussion. Authored play style only; not modeled on any real force.',
      tendencies:['Acts just after a courier window closes','Floods a single window with repeated sightings','Uses squall cover when lookouts are blind'],
      counters:['Group sightings by lineage before each window','Pre-plan what the next window must show to release a reserve','Treat squall periods as low-confidence intervals']},
    lessons:{
      'source-lineage':{title:'Spotting the port agent summary that repeats the lookout',note:'The port agent compiles whatever the lookout and ferry already sent; it arrives later and reads like confirmation.',glossary:['port-agent-summary','cay-lookout','sighting-flood']},
      'corroboration-threshold':{title:'A second sighting before sending the seaplane',note:'Pelican-1 has one sortie per tender turnaround; spending it on a single lookout log leaves the outer cays uncovered.',glossary:['cay-lookout','swell-landing-limit','port-agent-summary']},
      'reserve-allocation':{title:'Launch or hold: the island cutter reserve',note:'Tradewind covers the outer cays slowly, so holding and moving both carry real cost.',glossary:['hurricane-season-hold','pier-slot','drum-fuel']},
      'communication-delay':{title:'Deciding between courier windows',note:'The courier net adds fixed delay; a correction can sit in the queue until after a decision.',glossary:['courier-window','sighting-flood','revised-log']},
      'weather-logistics-window':{title:'Squall lines, pier slots and when to sail',note:'A squall stops drum fuel handling and a missed pier slot pushes resupply back a full cycle.',glossary:['tropical-wave-squall','pier-slot','drum-fuel']},
      'confidence-calibration':{title:'Confidence when the only lookout is on one cay',note:'One vantage point at night gives a narrow view; stated confidence should reflect that.',glossary:['cay-lookout','tropical-wave-squall','revised-log']},
    },
    names:['Ellis Brightwater','Perrin Sloane','Nell Ambergate','Caspian Rook','Hollis Fenwick','Isolde Crane','Rafe Tolliver','Delphine Ash','Emrys Coble','Linnea Vance','Thaddeus Moor','Oona Galloway'],
  },
  {
    aor:{id:'hormuz',name:'Strait of Hormuz',theater:'Gulf chokepoint maritime context setting',playableScenarioId:null,
      summary:'Context-only setting with no playable scenario. Fictional shipping-safety cells manage pilot boats, patrol boats, a survey drone and fuel lighters around a congested chokepoint with shamal winds, dust haze and heat limits. A public energy-chokepoint reference is linked for context only.',
      focus:['maritime resource allocation','congested traffic lanes','evidence validation','conflicting reports','heat, haze and lighter logistics','decisions under uncertainty'],
      sourceIds:['eia-chokepoints','natural-earth-terms']},
    historicalSourceId:'eia-chokepoints',
    historicalFraming:'Public reference on shipping chokepoints for context. The fictional lanes, queues and traffic figures in this setting are not drawn from it.',
    historicalLessons:['reserve-allocation','weather-logistics-window'],
    sectors:['Sector Saffron Anchorage','Sector Dune Point','Sector Amber Roads','Sector Lighter Basin','Sector Falcon Shoal','Sector Inbound Lane Two'],
    subjects:[
      {full:'a tanker stopped out of turn in the anchorage queue',short:'tanker stopped out of queue',group:false},
      {full:'a fishing-boat cluster drifting toward the inbound lane',short:'fishing-boat cluster by the inbound lane',group:true},
      {full:'a bulk carrier reporting a steering fault',short:'bulk carrier with a steering fault',group:false},
      {full:'a fuel lighter loitering beyond its service area',short:'lighter beyond its service area',group:false},
      {full:'a dhow group crossing the outbound lane',short:'dhow group in the outbound lane',group:true},
      {full:'small unidentified hulls keeping station near a pilot boat',short:'small hulls near a pilot boat',group:true},
    ],
    countUnit:'hulls',corroborationAssetKey:'ibis-3-drone',
    weather:['a shamal wind raising short steep seas','dust haze cutting visual range','midday heat forcing engine derates'],
    transport:['the fuel lighter queue backed up at the service berth','the pilot boat roster down one crew for the shift','a spare-parts launch held for a port clearance window'],
    comms:['a congested satellite relay link','the port VHF working channel saturated with queue traffic'],
    sources:{primary:'Lane monitor station West',derivative:'Shipping agency advisory',conflict:'Master of fuel lighter Amberline',logistics:'Service berth dispatch',correction:'Lane monitor station West, revised plot',corroboration:'Coastal survey drone Ibis-3'},
    assets:[
      {key:'saker-pilot-boat',title:'Demo pilot boat Saker',category:'patrol',reserve:true,enduranceTicks:24,summary:'Fictional pilot boat that can be pulled from boarding duty as a response reserve.',constraint:'Every tick away from boarding lengthens the anchorage queue.',tags:['reserve','transport']},
      {key:'dune-patrol-boat',title:'Demo harbor patrol boat Dune',category:'patrol',reserve:true,enduranceTicks:30,summary:'Fictional patrol boat for lane safety checks.',constraint:'Short steep shamal seas cut its speed sharply.',tags:['reserve','weather']},
      {key:'ibis-3-drone',title:'Demo coastal survey drone Ibis-3',category:'patrol',reserve:true,enduranceTicks:10,summary:'Fictional short-endurance drone for quick looks along the lanes.',constraint:'Grounded in heavy dust haze and derated in midday heat.',tags:['reserve','weather','corroboration']},
      {key:'lane-monitor-west',title:'Demo lane monitor station West',category:'sensor',reserve:false,enduranceTicks:0,summary:'Fictional shore station that originates most lane plots.',constraint:'Plots of small hulls degrade in haze; counts drift.',tags:['provenance','confidence']},
      {key:'vhf-working-channel',title:'Demo port VHF working channel',category:'communications',reserve:false,enduranceTicks:0,summary:'Fictional shared channel for pilots, lighters and the watch.',constraint:'Saturates when the queue is long, delaying reports.',tags:['communication']},
      {key:'satellite-relay-link',title:'Demo satellite relay link',category:'communications',reserve:false,enduranceTicks:0,summary:'Fictional backhaul for drone imagery and station plots.',constraint:'Congests during heavy traffic; imagery arrives in batches.',tags:['communication']},
      {key:'amberline-lighter',title:'Demo fuel lighter Amberline',category:'logistics',reserve:false,enduranceTicks:40,summary:'Fictional lighter that refuels patrol and pilot boats.',constraint:'One service berth; the queue sets refuel timing.',tags:['transport']},
      {key:'service-berth-dispatch',title:'Demo service berth dispatch',category:'logistics',reserve:false,enduranceTicks:0,summary:'Fictional dispatcher for berth, crew and parts scheduling.',constraint:'Crew and parts changes need a clearance window.',tags:['transport']},
      {key:'haze-2-mast',title:'Demo visibility sensor mast Haze-2',category:'weather',reserve:false,enduranceTicks:0,summary:'Fictional mast reporting visual range, wind and temperature.',constraint:'Measures one point; haze varies along the lanes.',tags:['weather','confidence']},
    ],
    glossary:[
      {key:'traffic-lane',term:'Traffic lane',definition:'Authored inbound or outbound game lane; hulls outside it trigger safety checks.',tags:['transport']},
      {key:'anchorage-queue',term:'Anchorage queue',definition:'Ordered list of hulls waiting for a pilot; pulling a pilot boat lengthens it.',tags:['transport','reserve']},
      {key:'shamal',term:'Shamal',definition:'Game weather condition with strong wind and short steep seas that slows small boats.',tags:['weather']},
      {key:'dust-haze',term:'Dust haze',definition:'Game visibility condition that grounds the drone and weakens visual reports.',tags:['weather','confidence','corroboration']},
      {key:'heat-derate',term:'Heat derate',definition:'Midday game rule that reduces engine output and drone endurance.',tags:['weather','transport']},
      {key:'pilot-boarding-window',term:'Pilot boarding window',definition:'Ticks during which a pilot boat must stay on boarding duty to keep the queue moving.',tags:['reserve','transport']},
      {key:'shipping-advisory',term:'Shipping agency advisory',definition:'Compiled notice that restates station plots for shipping. Derivative, not independent.',tags:['provenance','corroboration']},
      {key:'revised-plot',term:'Revised plot',definition:'Station correction that replaces an earlier plot; the earlier plot is superseded.',tags:['source-change','provenance']},
      {key:'lighter-service-area',term:'Lighter service area',definition:'Authored box where fuel lighters may operate; lighters outside it need a check.',tags:['transport']},
      {key:'vhf-saturation',term:'VHF saturation',definition:'Condition where the working channel is so busy that reports queue for several ticks.',tags:['communication']},
      {key:'chokepoint-throughput',term:'Chokepoint throughput',definition:'Game measure of hulls cleared per tick window. The linked reference discusses chokepoints in general; this game measure is not taken from it.',tags:['transport','provenance'],sourceIds:['eia-chokepoints']},
      {key:'strait-of-hormuz-map-name',term:'Strait of Hormuz (map name)',definition:'Marine area name used for the context setting. The linked geographic data reference is context only; lanes and sectors are fictional and no regional map is imported.',tags:['provenance'],sourceIds:['natural-earth-terms']},
    ],
    orgs:{
      commander:{key:'chokepoint-safety-watch',title:'Demo Chokepoint Safety Watch',summary:'Fictional watch that assigns pilot boats, patrol boats and the drone to lane safety checks.'},
      intelligence:{key:'lane-picture-desk',title:'Demo Lane Picture Desk',summary:'Fictional desk that reconciles station plots, pilot reports and agency advisories.'},
      instructor:{key:'gulf-seminar-control',title:'Demo Gulf Seminar Control',summary:'Fictional seminar facilitators who run context-only chokepoint discussion cases.'},
    },
    red:{key:'haze-runner',title:'Red Cell Haze Runner (fictional)',summary:'Fictional seminar opponent for context-only discussion. Authored play style only; not modeled on any real force.',
      tendencies:['Acts when dust haze grounds the drone','Creates queue disruptions that pull pilot boats off boarding','Times activity to channel saturation so reports queue'],
      counters:['Name which reports stay reliable in haze','Price the queue cost before pulling a pilot boat','Plan decisions around known channel delay']},
    lessons:{
      'source-lineage':{title:'Agency advisories that echo the lane monitor',note:'Shipping agency advisories restate station West plots for shipping; they carry its errors along with its findings.',glossary:['shipping-advisory','revised-plot','traffic-lane']},
      'corroboration-threshold':{title:'An independent plot before moving a pilot boat',note:'Pulling Saker off boarding lengthens the anchorage queue for every tick it is away.',glossary:['pilot-boarding-window','anchorage-queue','shipping-advisory']},
      'reserve-allocation':{title:'Pilot boats as a scarce reserve in the queue',note:'The same boat is the queue\'s throughput and the watch\'s reserve; both uses have a price.',glossary:['anchorage-queue','pilot-boarding-window','chokepoint-throughput']},
      'communication-delay':{title:'Deciding across a saturated VHF channel',note:'When the queue is long the working channel saturates and corrections wait behind routine traffic.',glossary:['vhf-saturation','revised-plot','anchorage-queue']},
      'weather-logistics-window':{title:'Shamal, haze and the lighter queue',note:'Haze grounds the drone, shamal seas slow the boats, and the single lighter berth sets refuel timing.',glossary:['shamal','dust-haze','heat-derate']},
      'confidence-calibration':{title:'Confidence ranges when haze hides the lane',note:'Station plots of small hulls drift in haze; ranges should say how much.',glossary:['dust-haze','shipping-advisory','revised-plot']},
    },
    names:['Soren Pike','Verity Lowe','Anselm Draycott','Briar Wolcott','Cato Merriweather','Hester Quill','Lucan Hartwell','Mirela Stroud','Tobin Glass','Wren Alcott','Ivo Selden','Clio Barrowe'],
  },
];

const LESSON_OBJECTIVES:Record<LessonKey,{objective:string;outcomeVsReasoning:string;tags:string[]}>={
  'source-lineage':{objective:'Group reports by lineage before counting them; a compiled or relayed report is not a second independent observation.',outcomeVsReasoning:'A double count can still land on the right answer. Review whether the count was right at the time, separately from what happened.',tags:['provenance','corroboration','source-change']},
  'corroboration-threshold':{objective:'Set, before reports arrive, how many independent lineages a commitment needs and what the deadline fallback is.',outcomeVsReasoning:'Waiting can be sound and still cost the window; moving early can be unsound and still work.',tags:['corroboration','reserve','confidence']},
  'reserve-allocation':{objective:'Price both holding and committing a scarce reserve, and tie release to named reports or ticks.',outcomeVsReasoning:'An idle reserve that was never needed is not proof that holding was reasoned; name the trigger that would have released it.',tags:['reserve','transport','confidence']},
  'communication-delay':{objective:'Account for known relay delay: estimate what may already be in the queue and set report-back ticks accordingly.',outcomeVsReasoning:'Delay changes what could be known at a tick. Judge decisions against released reports, not against the final picture.',tags:['communication','source-change','corroboration']},
  'weather-logistics-window':{objective:'Treat weather and logistics windows as decision inputs with their own timing, not as background.',outcomeVsReasoning:'Weather can make a sound decision fail or rescue a weak one; review the window estimate, not only the result.',tags:['weather','transport','reserve']},
  'confidence-calibration':{objective:'State confidence as a range, move it with each report, and record what would change it.',outcomeVsReasoning:'One case cannot show calibration. Compare stated ranges with results across several cases.',tags:['confidence','corroboration','provenance']},
};

const BEHAVIOR_PROFILE:Record<BehaviorKey,{label:string;strength:string;limitation:string}>={
  'derivative-double-count-corrected':{label:'Derivative double count, then corrected',strength:'Audits report lineage when accounts conflict and corrects the count explicitly.',limitation:'First counts can include relayed or compiled reports as if independent.'},
  'waits-for-corroboration':{label:'Waits for corroboration',strength:'Ties commitments to an independent second lineage.',limitation:'Can let a deadline pass without a fallback plan.'},
  'premature-commitment':{label:'Premature commitment',strength:'Moves quickly when a window appears to be closing.',limitation:'Commits before checking lineage and relay delay.'},
  'conservative-hold':{label:'Conservative hold',strength:'Protects a scarce reserve from misplacement while reports conflict.',limitation:'Holds without a named release trigger, sometimes after evidence converges.'},
  'evidence-update-delegation':{label:'Evidence update with delegation',strength:'Delegates lineage checks with report-back ticks and updates promptly.',limitation:'Depends on the delegate report-back; staging can split capacity.'},
  'calibration':{label:'Calibrated confidence',strength:'States confidence ranges that move with each report.',limitation:'Numeric ranges can suggest more precision than the reports support.'},
};

// ---------------------------------------------------------------- helpers

const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const uniq=<T,>(xs:T[])=>[...new Set(xs)];
const link=(relation:CatalogLink['relation'],targetId:string):CatalogLink=>({relation,targetId});
const cap=(s:string)=>s.charAt(0).toUpperCase()+s.slice(1);

function record(r:Omit<CatalogRecord,'tags'>&{tags:string[]}):CatalogRecord {
  return {...r,tags:uniq(r.tags.map(slug)).sort()};
}

interface RolePhrases {commit:(t:string)=>string;hold:string;retask:(t:string)=>string;ask:string;delegate:string;stage:string;prepare:string;constraint:string}
function rolePhrases(role:CatalogRole,reserve:string):RolePhrases {
  if(role==='commander') return {
    commit:t=>`commits ${reserve} toward ${t}`,hold:`holds ${reserve} in reserve`,retask:t=>`re-tasks ${reserve} toward ${t}`,
    ask:'asks the intelligence desk for an independent check',delegate:'delegates source verification to the intelligence desk with a report-back tick',
    stage:`stages ${reserve} between sectors with named release triggers`,prepare:`readies ${reserve} for movement`,
    constraint:`Lengthens the transit estimate for ${reserve} and notes how little slack remains.`};
  if(role==='intelligence') return {
    commit:t=>`issues a firm assessment placing the contact toward ${t} and recommends moving ${reserve}`,hold:`keeps the assessment open and advises holding ${reserve}`,
    retask:t=>`issues a revised assessment toward ${t}`,ask:'tasks a second collection source for an independent look',
    delegate:'hands lineage tracing to a desk analyst with a report-back tick',stage:'issues a two-hypothesis assessment with named triggers',
    prepare:'drafts a high-confidence assessment',constraint:`Adds the constraint to the assessment: ${reserve} cannot recover from a late change of picture.`};
  return {
    commit:t=>`adjudicates the cell's move of ${reserve} toward ${t} as sound`,hold:`keeps adjudication of the ${reserve} move open`,
    retask:t=>`reopens adjudication and has the cell redirect ${reserve} toward ${t}`,ask:'prompts the cell to name an independent source before any ruling',
    delegate:'assigns lineage tracing to the trainee intelligence seat with a report-back tick',stage:'rules the inject partly resolved and names the report still pending',
    prepare:'drafts a ruling that credits two sources',constraint:'Pauses the cell to ask how the constraint changes the cost of waiting versus moving.'};
}

interface Ctx {
  role:RolePhrases;early:boolean;nature:Nature;sector:string;target:string;weather:string;transport:string;comm:string;
  r:string[];deadline:number;delay:number;subject:string;
  /** Ticks between the deadline and the final in-exercise move (0 when the move is the deadline decision). */
  lateBy:number;
}
type DecisionSlot='initial'|'conflict'|'deadline'|'correction'|'corroboration';
interface BehaviorSpec {
  counted:{initial:number;conflict:number};
  confidence:Record<DecisionSlot,string>;
  text:Record<DecisionSlot,(c:Ctx)=>string>;
  outcome:(c:Ctx)=>Rating<OutcomeRating>;
  reasoning:(c:Ctx)=>Rating<ReasoningRating>;
}

const CALIBRATION_CONFIDENCE=(early:boolean):Record<DecisionSlot,string>=>early
  ?{initial:'55-65%',conflict:'35-45%',correction:'60-70%',corroboration:'80-90%',deadline:'75-85%'}
  :{initial:'55-65%',conflict:'35-45%',deadline:'40-50%',correction:'70-80%',corroboration:'80-90%'};

const BEHAVIORS:Record<BehaviorKey,BehaviorSpec>={
  'premature-commitment':{
    counted:{initial:2,conflict:2},
    confidence:{initial:'high',conflict:'high',deadline:'high',correction:'moderate',corroboration:'moderate'},
    text:{
      initial:c=>`Reads ${c.r[1]} and ${c.r[2]} as two sightings and ${c.role.commit(c.sector)}. States high confidence.`,
      conflict:c=>`Notes ${c.r[4]} but treats it as the weaker account and keeps the commitment in place.`,
      deadline:c=>c.early?`Only at the deadline, several ticks after the correction and ${c.r[6]} arrived and after transit time was already spent, ${c.role.retask(c.target)}.`:`At the deadline nothing independent has arrived; stays with the earlier commitment.`,
      correction:c=>c.early?`${cap(c.r[5])} arrives a few ticks after the move; logs it but defers any change until the deadline.`:`${cap(c.r[5])} arrives after the deadline; ${c.role.retask(c.target)}.`,
      corroboration:c=>c.early?`${cap(c.r[6])} independently matches the correction.`:`${cap(c.r[6])} confirms the revised picture; the re-tasking completes.`,
    },
    outcome:c=>c.nature==='position'
      ?{rating:'costly',text:`The early commitment pointed at ${c.sector}; the corrected position was ${c.target}, so the move had to be reversed and the transit made under ${c.weather} was lost.`}
      :{rating:'favorable',text:`The commitment was in the right sector; the correction only reduced the count, so the move was larger than needed but useful.`},
    reasoning:c=>({rating:'unsupported',text:`When the commitment was made only one independent lineage existed: ${c.r[2]} restated ${c.r[1]}. ${c.early?'A correction was already a short relay delay away.':'The long relay delay was known and no fallback was set.'} The decision rule, not the result, is the review point.`}),
  },
  'waits-for-corroboration':{
    counted:{initial:1,conflict:1},
    confidence:{initial:'moderate',conflict:'low',deadline:'moderate',correction:'moderate',corroboration:'high'},
    text:{
      initial:c=>`Counts ${c.r[1]} as one lineage and notes ${c.r[2]} repeats it; ${c.role.hold}. States moderate confidence.`,
      conflict:c=>`Treats ${c.r[4]} as an independent conflicting account; ${c.role.ask}.`,
      deadline:c=>c.early?`With ${c.r[5]} and ${c.r[6]} agreeing from separate lineages, ${c.role.commit(c.target)}.`:`Nothing independent resolves the conflict by the deadline; keeps the hold and records the open question, without a fallback.`,
      correction:c=>c.early?`${cap(c.r[5])} supersedes the first report; waits for an independent match before acting.`:`${cap(c.r[5])} arrives after the deadline; begins planning the move on the corrected picture.`,
      corroboration:c=>c.early?`${cap(c.r[6])} matches the correction from a separate lineage; prepares the move for the deadline.`:`${cap(c.r[6])} confirms; ${c.role.commit(c.target)}, several ticks after the deadline.`,
    },
    outcome:c=>c.early
      ?{rating:'favorable',text:`The move went to ${c.target} on a corroborated picture before the deadline.`}
      :{rating:'mixed',text:`The reserve was not misplaced, but it moved ${c.lateBy} ticks after the deadline and its time on station was shortened by ${c.weather}.`},
    reasoning:c=>({rating:'supported',text:`The threshold of two independent lineages was applied consistently. ${c.early?'The short relay delay made waiting cheap.':'With a long relay delay, a pre-set fallback at the deadline was the missing piece.'}`}),
  },
  'derivative-double-count-corrected':{
    counted:{initial:2,conflict:1},
    confidence:{initial:'high',conflict:'low',deadline:'moderate',correction:'moderate',corroboration:'high'},
    text:{
      initial:c=>`Counts ${c.r[1]} and ${c.r[2]} as two sources, raises confidence to high and ${c.role.prepare}.`,
      conflict:c=>`${cap(c.r[4])} prompts a lineage check: ${c.r[2]} was compiled from ${c.r[1]}. Corrects the count to one supporting lineage against one conflicting lineage and lowers confidence.`,
      deadline:c=>c.early?`With the corrected count and ${c.r[5]} and ${c.r[6]} in hand, ${c.role.commit(c.target)}.`:`Using the corrected count, ${c.role.hold} instead of the planned move and records why.`,
      correction:c=>c.early?`${cap(c.r[5])} supersedes ${c.r[1]}; marks ${c.r[2]} as affected too because it inherits from the superseded report.`:`${cap(c.r[5])} supersedes ${c.r[1]}; ${c.role.commit(c.target)}.`,
      corroboration:c=>`${cap(c.r[6])} matches the correction from a separate lineage; confidence raised.`,
    },
    outcome:c=>c.nature==='position'
      ?{rating:'mixed',text:`Preparation aimed at ${c.sector} had to be unwound, but no commitment was made there; the final move went to ${c.target}.`}
      :{rating:'favorable',text:`The final move matched the revised count in ${c.sector}.`},
    reasoning:c=>({rating:'partly-supported',text:`The first count treated a derivative report as independent. The correction at the conflict was prompt and explicit, and it ${c.early?'carried through to the superseded report':'prevented a move on inflated confidence'}.`}),
  },
  'conservative-hold':{
    counted:{initial:1,conflict:1},
    confidence:{initial:'low',conflict:'low',deadline:'low',correction:'moderate',corroboration:'moderate'},
    text:{
      initial:c=>`Counts one lineage; ${c.role.hold}. States low confidence.`,
      conflict:c=>`Treats ${c.r[4]} as grounds to keep holding; sets no report-back tick or release trigger.`,
      deadline:c=>c.early?`${cap(c.r[5])} and ${c.r[6]} already agree, yet the hold continues for one more check and the deadline passes.`:`Keeps holding at the deadline; the window that follows is narrowed by ${c.weather}.`,
      correction:c=>c.early?`${cap(c.r[5])} arrives; logs it without changing the hold.`:`${cap(c.r[5])} arrives; begins planning a release.`,
      corroboration:c=>c.early?`${cap(c.r[6])} matches the correction; notes the agreement but asks for another look.`:`${cap(c.r[6])} confirms; ${c.role.commit(c.target)}; logistics add delay (${c.transport}).`,
    },
    outcome:c=>c.early
      ?{rating:'costly',text:`Evidence converged before the deadline but nothing moved, and the window then closed under ${c.weather}.`}
      :{rating:'mixed',text:`The reserve avoided a misplaced move but reached ${c.target} ${c.lateBy} ticks after the deadline, in a shrinking window.`},
    reasoning:c=>({rating:'partly-supported',text:`Holding under conflicting reports was defensible. ${c.early?'Continuing to hold after two independent lineages agreed was not.':'The missing element was a release trigger tied to specific reports or ticks.'}`}),
  },
  'evidence-update-delegation':{
    counted:{initial:1,conflict:1},
    confidence:{initial:'moderate',conflict:'low',deadline:'moderate',correction:'high',corroboration:'high'},
    text:{
      initial:c=>`Counts one lineage and flags ${c.r[2]} as a possible repeat; ${c.role.hold}. States moderate confidence.`,
      conflict:c=>`${cap(c.r[4])} conflicts with the first report; ${c.role.delegate}.`,
      deadline:c=>c.early?`The report-back plus ${c.r[5]} and ${c.r[6]} give a converged picture; ${c.role.commit(c.target)}.`:`The report-back confirms ${c.r[2]} is derivative and the conflict is open; ${c.role.stage}.`,
      correction:c=>c.early?`${cap(c.r[5])} arrives; the delegate checks it against the lineage map within one tick.`:`${cap(c.r[5])} matches a named trigger; updates within one tick and ${c.role.commit(c.target)}.`,
      corroboration:c=>c.early?`${cap(c.r[6])} independently confirms the correction.`:`${cap(c.r[6])} confirms; the move completes from the staged position.`,
    },
    outcome:c=>c.early||c.nature==='position'
      ?{rating:'favorable',text:`The move reached ${c.target} ${c.early?'before the deadline':'soon after the correction because the reserve was staged'}.`}
      :{rating:'mixed',text:`The staged position served, but splitting coverage across two sectors used endurance that logistics could not quickly restore (${c.transport}).`},
    reasoning:c=>({rating:'supported',text:`Delegated the lineage check with a report-back tick and updated as soon as the named report arrived. ${c.early?'':'Staging was a reasoned hedge given the long relay delay.'}`.trim()}),
  },
  'calibration':{
    counted:{initial:1,conflict:1},
    confidence:CALIBRATION_CONFIDENCE(false),
    text:{
      initial:c=>`Counts one lineage and notes ${c.r[2]} is a repeat; states 55-65% that the contact is in ${c.sector} and ${c.role.stage}.`,
      conflict:c=>`Lowers to 35-45% after ${c.r[4]} and records which report would move the estimate.`,
      deadline:c=>c.early?`With ${c.r[5]} and ${c.r[6]} in hand, raises to 75-85% for the corrected picture and ${c.role.commit(c.target)}.`:`Nothing new by the deadline; ${c.role.commit(c.sector)} at a stated 40-50% with a pre-planned turn-back point.`,
      correction:c=>c.early?`${cap(c.r[5])} arrives; moves to 60-70% for the corrected picture pending an independent match.`:`${cap(c.r[5])} arrives; shifts to 70-80% for the corrected picture and uses the turn-back point.`,
      corroboration:c=>`${cap(c.r[6])} arrives from a separate lineage; raises to 80-90%.`,
    },
    outcome:c=>!c.early&&c.nature==='position'
      ?{rating:'mixed',text:`The low-confidence move toward ${c.sector} was turned back at the planned point and redirected to ${c.target}.`}
      :{rating:'favorable',text:`The move matched the picture at ${c.target}.`},
    reasoning:()=>({rating:'supported',text:'Confidence ranges widened on conflict and narrowed on independent corroboration, with the reason recorded each time. A single case cannot show calibration; compare across cases.'}),
  },
};
// ---------------------------------------------------------------- builders

type Slot=DecisionSlot|'constraint'|'outcome-review'|'reasoning-review';
const SLOT_ORDER:Record<Variant,Slot[]>={
  'late-correction':['initial','constraint','conflict','deadline','correction','corroboration','outcome-review','reasoning-review'],
  'early-corroboration':['initial','constraint','conflict','correction','corroboration','deadline','outcome-review','reasoning-review'],
};
const SLOT_LABEL:Record<Slot,string>={
  initial:'Initial read',constraint:'Weather and logistics constraint',conflict:'Conflicting account',deadline:'Decision deadline',
  correction:'Correction received',corroboration:'Independent report received','outcome-review':'Post-hoc review: outcome','reasoning-review':'Post-hoc review: reasoning',
};
const SLOT_TAGS:Record<Slot,string[]>={
  initial:['provenance','confidence','reserve'],constraint:['weather','transport'],conflict:['corroboration','confidence'],deadline:['reserve','confidence'],
  correction:['source-change','provenance'],corroboration:['corroboration','communication'],'outcome-review':['review','outcome'],'reasoning-review':['review','reasoning'],
};

interface ReportPlan {n:number;observed:number;available:number}
function reportTicks(t0:number,d:number,early:boolean):ReportPlan[] {
  const rel=[[0,d],[0,d+2],[d+1,d+4],[2,d+5],early?[d+6,2*d+6]:[d+8,2*d+8],early?[d+8,2*d+8]:[d+10,2*d+11]];
  return rel.map(([o,a],i)=>({n:i+1,observed:t0+o,available:t0+a}));
}
function eventTicks(t0:number,d:number,early:boolean):Record<Slot,number> {
  const base={initial:d+3,constraint:d+5,conflict:d+6,deadline:DECISION_DEADLINE_OFFSET};
  const tail=early?{correction:2*d+7,corroboration:2*d+9}:{correction:2*d+9,corroboration:2*d+12};
  const last=Math.max(base.deadline,tail.corroboration);
  const rel={...base,...tail,'outcome-review':last+12,'reasoning-review':last+13};
  return Object.fromEntries(Object.entries(rel).map(([k,v])=>[k,t0+v])) as Record<Slot,number>;
}

interface CasePlan {slot:number;lesson:LessonKey;behavior:BehaviorKey;variant:Variant;contrastSlot:number|null}
const PERSONAS_PER_AOR=12;
const pairFor=(p:number)=>CONTRAST_PAIRS[(2*(p%3)+Math.floor(p/3))%CONTRAST_PAIRS.length];
/** Third-case behaviors: least-used behavior outside the persona's pair, so all six stay balanced per AOR. */
const THIRD_BEHAVIORS:BehaviorKey[]=(()=>{
  const used=new Map<BehaviorKey,number>(BEHAVIOR_ORDER.map(b=>[b,0]));
  return Array.from({length:PERSONAS_PER_AOR},(_,p)=>{
    const pair=pairFor(p);
    const pick=BEHAVIOR_ORDER.filter(b=>b!==pair.late&&b!==pair.early).reduce((best,b)=>used.get(b)!<used.get(best)!?b:best);
    used.set(pick,used.get(pick)!+1);
    return pick;
  });
})();
function casePlans(p:number):CasePlan[] {
  const pair=pairFor(p);
  const third=THIRD_BEHAVIORS[p];
  let lesson=PRIMARY_LESSON[third];
  if(lesson===pair.lesson) lesson=LESSON_KEYS[(LESSON_KEYS.indexOf(lesson)+1)%LESSON_KEYS.length];
  return [
    {slot:1,lesson:pair.lesson,behavior:pair.late,variant:'late-correction',contrastSlot:2},
    {slot:2,lesson:pair.lesson,behavior:pair.early,variant:'early-corroboration',contrastSlot:1},
    {slot:3,lesson,behavior:third,variant:p%2===0?'early-corroboration':'late-correction',contrastSlot:null},
  ];
}

export function createPresetCatalog():CatalogBundle {
  const sourceById=new Map<string,CatalogSource>(CATALOG_SOURCES.map(s=>[s.id,s]));
  const requireSource=(id:string)=>{const s=sourceById.get(id);if(!s) throw new Error(`preset catalog: missing CATALOG_SOURCES entry ${id}`);return s;};
  const records:CatalogRecord[]=[];
  const aors:CatalogAor[]=[];

  for(const spec of AORS){
    const aorId=spec.aor.id as CatalogAorId;
    spec.aor.sourceIds.forEach(requireSource);
    if(spec.names.length!==PERSONAS_PER_AOR) throw new Error(`preset catalog: ${aorId} needs ${PERSONAS_PER_AOR} persona names`);
    aors.push({...spec.aor,focus:[...spec.aor.focus],sourceIds:[...spec.aor.sourceIds]});
    const id=(kind:string,key:string)=>`${aorId}/${kind}/${key}`;
    const orgId=(role:CatalogRole)=>id('organization',spec.orgs[role].key);
    const redId=id('red-profile',spec.red.key);
    const historicalId=id('historical',spec.historicalSourceId);
    const assetId=(key:string)=>id('asset',key);
    const aorTag=[aorId];

    // Organizations
    for(const role of ROLES){
      const o=spec.orgs[role];
      records.push(record({id:orgId(role),aorId,kind:'organization',title:o.title,summary:o.summary,
        body:`${o.summary} Fictional game organization for ${spec.aor.name} practice cases; it does not describe any real unit or agency.`,
        roles:ALL_ROLES,tags:[...aorTag,role,'fictional'],provenance:'synthetic',sourceIds:[],links:[],
        fields:{primaryRole:role,fictional:true}}));
    }

    // Assets
    for(const a of spec.assets){
      const owner=a.category==='sensor'||a.category==='weather'?orgId('intelligence'):orgId('commander');
      records.push(record({id:assetId(a.key),aorId,kind:'asset',title:a.title,summary:a.summary,
        body:`${a.summary} Constraint: ${a.constraint} Fictional game entity; capabilities are authored for play, not real performance data.`,
        roles:ALL_ROLES,tags:[...aorTag,a.category,...a.tags],provenance:'synthetic',sourceIds:[],links:[link('belongs-to',owner)],
        fields:{category:a.category,reserveEligible:a.reserve,enduranceTicks:a.enduranceTicks,constraint:a.constraint,fictional:true}}));
    }

    // Glossary
    for(const g of spec.glossary){
      (g.sourceIds??[]).forEach(requireSource);
      records.push(record({id:id('glossary',g.key),aorId,kind:'glossary',title:g.term,summary:g.definition,body:g.definition,
        roles:ALL_ROLES,tags:[...aorTag,...g.tags],provenance:'synthetic',sourceIds:[...(g.sourceIds??[])],links:[],
        fields:{term:g.term,region:spec.aor.name}}));
    }

    // Historical reference card: summary is the source-provided original, body adds only discussion prompts.
    const hs=requireSource(spec.historicalSourceId);
    records.push(record({id:historicalId,aorId,kind:'historical',title:hs.title,summary:hs.summary,
      body:`${spec.historicalFraming} Read the linked original before discussing. Prompts: What information was available at each point, and how was its reliability judged? Where did the timing of reports shape choices? Discuss what turned out well separately from whether the reasoning at the time was supported. This card does not restate, extend or reenact the source.`,
      roles:ALL_ROLES,tags:[...aorTag,'historical','public-reference','communication','confidence'],provenance:'public-reference',sourceIds:[hs.id],links:[],
      fields:{publisher:hs.publisher,url:hs.url,retrievedAt:hs.retrievedAt,usage:hs.usage,scope:hs.scope,framing:spec.historicalFraming}}));

    // Red profile
    records.push(record({id:redId,aorId,kind:'red-profile',title:spec.red.title,summary:spec.red.summary,
      body:`${spec.red.summary} Tendencies: ${spec.red.tendencies.join('; ')}. Blue counters practiced in cases: ${spec.red.counters.join('; ')}.`,
      roles:ALL_ROLES,tags:[...aorTag,'red-cell','fictional','communication','provenance'],provenance:'synthetic',sourceIds:[],links:[],
      fields:{tendencies:[...spec.red.tendencies],counters:[...spec.red.counters],fictional:true,playable:spec.aor.playableScenarioId!==null,scenarioId:spec.aor.playableScenarioId}}));

    // Lessons
    for(const key of LESSON_KEYS){
      const l=spec.lessons[key],o=LESSON_OBJECTIVES[key];
      const cites=spec.historicalLessons.includes(key);
      const glossaryIds=l.glossary.map(g=>id('glossary',g));
      records.push(record({id:id('lesson',key),aorId,kind:'lesson',title:l.title,summary:o.objective,
        body:`${o.objective} ${l.note} Outcome versus reasoning: ${o.outcomeVsReasoning}`,
        roles:ALL_ROLES,tags:[...aorTag,'lesson',key,...o.tags],provenance:'synthetic',sourceIds:cites?[spec.historicalSourceId]:[],
        links:[...glossaryIds.map(g=>link('uses',g)),...(cites?[link('cites',historicalId)]:[])],
        fields:{lessonKey:key,objective:o.objective,regionNote:l.note,outcomeVsReasoning:o.outcomeVsReasoning,glossaryIds}}));
    }

    // The corroborating source never doubles as the reserve being held or moved (conflict sources are non-reserve assets or people).
    const reserves=spec.assets.filter(a=>a.reserve&&a.key!==spec.corroborationAssetKey);
    const logistics=spec.assets.filter(a=>a.category==='logistics');
    const sensor=spec.assets.find(a=>a.category==='sensor')!;
    const comms=spec.assets.filter(a=>a.category==='communications');

    // Personas and cases
    spec.names.forEach((name,p)=>{
      const role=ROLES[p%3];
      const personaKey=slug(name);
      const personaId=id('persona',personaKey);
      const displayName=`Demo ${name}`;
      const plans=casePlans(p);
      const caseIdOf=(slot:number)=>id('case',`${personaKey}-${slot}`);
      const ratings:ReasoningRating[]=[];
      const subjectIdx=p%spec.subjects.length;

      for(const plan of plans){
        const caseId=caseIdOf(plan.slot);
        const early=plan.variant==='early-corroboration';
        const subject=spec.subjects[plan.slot===3?(subjectIdx+3)%spec.subjects.length:subjectIdx];
        const nature:Nature=subject.group&&(plan.slot===3?p+1:p)%2===1?'count':'position';
        const sectorIdx=(p+plan.slot*2)%spec.sectors.length;
        const sector=spec.sectors[sectorIdx],altSector=spec.sectors[(sectorIdx+3)%spec.sectors.length];
        const delay=early?2+(p+plan.slot)%3:6+(p*3+plan.slot)%4;
        const t0=12+((p*7+plan.slot*11)%9)*4;
        const reserve=reserves[(p+plan.slot)%reserves.length];
        const logi=logistics[(p*2+plan.slot)%logistics.length];
        const comm=comms[(p+plan.slot)%comms.length];
        const weather=spec.weather[(p+plan.slot*2)%spec.weather.length];
        const transport=spec.transport[(p*2+plan.slot)%spec.transport.length];
        const commText=spec.comms[(p+plan.slot)%spec.comms.length];
        const target=nature==='position'?altSector:`${sector} with a right-sized element`;
        const [bigCount,smallCount]=[5+(p+plan.slot)%3,2];
        const rTicks=reportTicks(t0,delay,early);
        const eTicks=eventTicks(t0,delay,early);
        const reportId=(n:number)=>`${caseId}/report-${n}`;
        const eventIds=SLOT_ORDER[plan.variant].map((_,i)=>`${caseId}/event-${i+1}`);
        const eventIdOf=(slot:Slot)=>eventIds[SLOT_ORDER[plan.variant].indexOf(slot)];
        const src=spec.sources;
        const labels=['',src.primary,src.derivative,src.logistics,src.conflict,src.correction,src.corroboration];
        const r=labels.map((l,n)=>n===0?'':`${l} (report ${n})`);
        const behavior=BEHAVIORS[plan.behavior];
        const confidence=plan.behavior==='calibration'?CALIBRATION_CONFIDENCE(early):behavior.confidence;
        const ctx:Ctx={role:rolePhrases(role,reserve.title),early,nature,sector,target,weather,transport,comm:commText,r,deadline:t0+DECISION_DEADLINE_OFFSET,delay,subject:subject.short,
          lateBy:early?0:eTicks.corroboration-eTicks.deadline};
        const outcome=behavior.outcome(ctx),reasoning=behavior.reasoning(ctx);
        ratings.push(reasoning.rating);
        const contact=nature==='position'?`in ${sector}`:`in ${sector}, estimated at ${bigCount} ${spec.countUnit}`;
        const illus='Illustrative authored report text, not an engine observation.';

        // Reports
        type RSpec={title:string;summary:string;detail:string;lineage:string;lineageRoot:string;independent:boolean;topic:'contact'|'constraint';conf:string;tags:string[];links:CatalogLink[];extra:CatalogRecord['fields']};
        const correctionText=nature==='position'
          ?`Revised position for the ${subject.short}: ${altSector}, not ${sector}.`
          :`Revised estimate: ${smallCount} ${spec.countUnit} in ${sector}, not ${bigCount}.`;
        const rs:RSpec[]=[
          {title:`${src.primary}: ${subject.short}`,summary:`First report of ${subject.full} ${contact}.`,
            detail:`${src.primary} reports ${subject.full} ${contact}. Passed over ${commText}.`,lineage:'primary',lineageRoot:'a',independent:true,topic:'contact',conf:'moderate',
            tags:['provenance','communication'],links:[],extra:{reportedSector:sector,reportedCount:nature==='count'?bigCount:null}},
          {title:`${src.derivative}: restates the first report`,summary:`Compiled notice that repeats report 1 in fresh wording.`,
            detail:`${src.derivative} repeats, as a "further sighting", ${subject.full} ${contact}. It was compiled from report 1 after that report was released and adds no new observation; its observed tick is that of report 1.`,
            lineage:'derivative',lineageRoot:'a',independent:false,topic:'contact',conf:'high',tags:['provenance','corroboration'],
            links:[link('derived-from',reportId(1))],extra:{derivedFromReportId:reportId(1),compiledAtTick:rTicks[0].available}},
          {title:`${src.logistics}: weather and transport`,summary:`Constraint report: ${weather}; ${transport}.`,
            detail:`${src.logistics} reports ${weather} and ${transport}. ${logi.title}: ${logi.constraint}`,
            lineage:'independent',lineageRoot:'c',independent:true,topic:'constraint',conf:'high',tags:['weather','transport','reserve'],links:[],extra:{logisticsAssetId:assetId(logi.key)}},
          {title:`${src.conflict}: conflicting account`,summary:nature==='position'?`Sees nothing in ${sector}; reports activity toward ${altSector}.`:`Sees only ${smallCount} ${spec.countUnit} in ${sector}.`,
            detail:`${src.conflict}, observing separately from report 1, ${nature==='position'?`sees nothing matching the ${subject.short} in ${sector} and notes activity toward ${altSector}`:`counts ${smallCount} ${spec.countUnit} in ${sector}, fewer than report 1`}. Its reporting path was slower.`,
            lineage:'independent',lineageRoot:'b',independent:true,topic:'contact',conf:'low',tags:['corroboration','confidence'],
            links:[link('disputes',reportId(1))],extra:{disputesReportIds:[reportId(1)]}},
          {title:`${src.correction}`,summary:correctionText,
            detail:`${src.correction} replaces report 1. ${correctionText} Report 2 inherited the superseded content.`,
            lineage:'correction',lineageRoot:'a',independent:false,topic:'contact',conf:'moderate',tags:['source-change','provenance'],
            links:[link('supersedes',reportId(1))],extra:{supersedesReportId:reportId(1)}},
          {title:`${src.corroboration}: independent look`,summary:`Separate look consistent with the correction.`,
            detail:`${src.corroboration} makes a separate look and finds ${nature==='position'?`the ${subject.short} in ${altSector}`:`${smallCount} ${spec.countUnit} in ${sector}`}. Consistent with report 5, from a different lineage.`,
            lineage:'independent',lineageRoot:'d',independent:true,topic:'contact',conf:'high',tags:['corroboration','communication','confidence'],
            links:[],extra:{corroboratesReportId:reportId(5)}},
        ];
        const reportRecordIds:string[]=[];
        rs.forEach((s,i)=>{
          const n=i+1,t=rTicks[i];
          reportRecordIds.push(reportId(n));
          records.push(record({id:reportId(n),aorId,kind:'report',title:s.title,summary:s.summary,body:`${illus} ${s.detail}`,
            roles:ALL_ROLES,tags:[...aorTag,'report',s.lineage,...s.tags],provenance:'synthetic',sourceIds:[],
            links:[link('belongs-to',caseId),...s.links],personaId,caseId,observedTick:t.observed,availableAtTick:t.available,
            fields:{sequence:n,sourceLabel:labels[n],lineage:s.lineage,lineageRoot:s.lineageRoot,independent:s.independent,topic:s.topic,
              statedConfidence:s.conf,reportingDelayTicks:t.available-t.observed,supersededByReportId:n===1?reportId(5):null,
              derivedFromReportId:null,supersedesReportId:null,disputesReportIds:null,corroboratesReportId:null,illustrative:true,engineObservation:false,...s.extra}}));
        });

        // Events
        const released=(tick:number)=>rTicks.filter(t=>t.available<=tick).map(t=>t.n);
        const citesFor=(slot:Slot,tick:number):number[]=>{
          const want:Record<Slot,number[]>={initial:[1,2],constraint:[3],conflict:[4,1,2],deadline:[1,2,3,4,5,6],correction:[5,1],corroboration:[6,5],'outcome-review':[5,6],'reasoning-review':[1,2,4]};
          const avail=new Set(released(tick));
          return want[slot].filter(n=>avail.has(n));
        };
        const decisionSlot:DecisionSlot='deadline';
        const finalMoveSlot:Slot=early?'deadline':'corroboration';
        SLOT_ORDER[plan.variant].forEach((slot,i)=>{
          const tick=eTicks[slot],evId=eventIds[i];
          const cites=citesFor(slot,tick);
          const releasedContactRoots=uniq(rTicks.filter(t=>t.available<=tick&&rs[t.n-1].topic==='contact'&&rs[t.n-1].independent).map(t=>rs[t.n-1].lineageRoot));
          const post=slot==='outcome-review'||slot==='reasoning-review';
          let body:string,eventType:string,summary:string,reviews:string[]=[];
          if(slot==='constraint'){
            body=`${cap(r[3])} arrives: ${weather}; ${transport}. ${ctx.role.constraint}`;eventType='assessment';summary=`Constraint noted: ${weather}.`;
          } else if(slot==='outcome-review'){
            reviews=uniq([eventIdOf(decisionSlot),eventIdOf(finalMoveSlot)]);
            body=`Post-hoc review, outcome only (${outcome.rating}). ${outcome.text} Outcome is reviewed separately from reasoning; a good result does not validate the reasoning and a poor one does not condemn it.`;
            eventType='review-outcome';summary=`Outcome: ${outcome.rating}.`;
          } else if(slot==='reasoning-review'){
            reviews=[eventIdOf('initial'),eventIdOf(decisionSlot)];
            body=`Post-hoc review, reasoning only (${reasoning.rating}), judged against reports released at each decision tick. ${reasoning.text} Lesson focus: ${LESSON_OBJECTIVES[plan.lesson].objective}`;
            eventType='review-reasoning';summary=`Reasoning: ${reasoning.rating}.`;
          } else {
            body=behavior.text[slot](ctx);
            eventType=slot==='conflict'&&plan.behavior==='evidence-update-delegation'?'delegation':slot==='initial'||slot==='conflict'?'assessment':slot==='deadline'?'decision':'update';
            summary=body.length>140?`${body.slice(0,body.lastIndexOf(' ',137))}...`:body;
          }
          const counted=slot==='initial'?behavior.counted.initial:slot==='conflict'?behavior.counted.conflict:null;
          const links:CatalogLink[]=[link('belongs-to',caseId),...cites.map(n=>link('cites',reportId(n))),
            ...(i<eventIds.length-1?[link('precedes',eventIds[i+1])]:[]),...reviews.map(e=>link('reviews',e))];
          if(!post) links.splice(1,0,link('authored-by',personaId));
          records.push(record({id:evId,aorId,kind:'event',title:`Tick ${tick} · ${SLOT_LABEL[slot]}`,summary,body,
            roles:uniq<CatalogRole>([role,'instructor']),tags:[...aorTag,'event',post?'post-hoc':'in-exercise',plan.behavior,plan.lesson,...SLOT_TAGS[slot]],
            provenance:'synthetic',sourceIds:[],links,personaId,caseId,observedTick:tick,availableAtTick:tick,
            fields:{sequence:i+1,tick,slot,label:SLOT_LABEL[slot],phase:post?'post-hoc':'in-exercise',eventType,
              citedReportIds:cites.map(reportId),statedConfidence:post||slot==='constraint'?null:confidence[slot as DecisionSlot],
              countedIndependentSupportingLineages:counted,actualIndependentSupportingLineages:counted===null?null:1,
              releasedIndependentContactLineages:releasedContactRoots.length,
              reviewFocus:slot==='outcome-review'?'outcome':slot==='reasoning-review'?'reasoning':null,
              rating:slot==='outcome-review'?outcome.rating:slot==='reasoning-review'?reasoning.rating:null,
              reviewsEventIds:reviews.length?reviews:null,previousEventId:i>0?eventIds[i-1]:null,nextEventId:i<eventIds.length-1?eventIds[i+1]:null,
              isDecisionDeadline:slot==='deadline',authoredExample:true,engineReplay:false}}));
        });

        // Case
        const lessonSpec=spec.lessons[plan.lesson];
        const otherId=plan.contrastSlot===null?null:caseIdOf(plan.contrastSlot);
        const contrastNote=plan.contrastSlot===null?null:early
          ?`Same lesson and deadline tick offset as the paired case. Here the relay delay was ${delay} ticks, so the correction and an independent report arrived before the deadline.`
          :`Same lesson and deadline tick offset as the paired case. Here the relay delay was ${delay} ticks, so the correction arrived only after the deadline.`;
        const variantLabel=early?'short relay delay':'long relay delay';
        const caseTags=[...aorTag,'case',plan.behavior,plan.lesson,plan.variant,role,'reserve','provenance','weather','transport','communication','corroboration','confidence','source-change'];
        records.push(record({id:caseId,aorId,kind:'case',title:`${displayName} · ${subject.short} (${variantLabel})`,
          summary:`${BEHAVIOR_PROFILE[plan.behavior].label} on "${lessonSpec.title}". Outcome ${outcome.rating}; reasoning ${reasoning.rating}.`,
          body:`Authored synthetic example, not a recorded game, engine replay or assessment of a real person. First report: ${subject.full} ${contact}. Conditions: ${weather}; ${transport}. Reports pass over ${commText}, with a relay delay of ${delay} ticks; the decision deadline is tick ${t0+DECISION_DEADLINE_OFFSET}. ${lessonSpec.note} Outcome (${outcome.rating}): ${outcome.text} Reasoning (${reasoning.rating}): ${reasoning.text}${contrastNote?` ${contrastNote}`:''}`,
          roles:uniq<CatalogRole>([role,'instructor']),tags:caseTags,provenance:'synthetic',sourceIds:[],
          links:[link('authored-by',personaId),link('uses',id('lesson',plan.lesson)),link('uses',assetId(reserve.key)),link('uses',assetId(sensor.key)),
            link('uses',assetId(logi.key)),link('uses',assetId(comm.key)),link('uses',redId),...(otherId?[link('contrasts-with',otherId)]:[])],
          personaId,caseId,
          fields:{personaId,lessonId:id('lesson',plan.lesson),behavior:plan.behavior,behaviorLabel:BEHAVIOR_PROFILE[plan.behavior].label,variant:plan.variant,
            startTick:t0,decisionDeadlineTick:t0+DECISION_DEADLINE_OFFSET,reviewTick:eTicks['outcome-review'],relayDelayTicks:delay,
            correctionNature:nature,sector,correctedSector:nature==='position'?altSector:sector,subject:subject.full,weather,transport,communication:commText,
            outcomeRating:outcome.rating,outcomeLesson:outcome.text,reasoningRating:reasoning.rating,reasoningLesson:reasoning.text,
            contrastCaseId:otherId,contrastNote,reportIds:reportRecordIds,eventIds,
            reserveAssetId:assetId(reserve.key),assetIds:[assetId(reserve.key),assetId(sensor.key),assetId(logi.key),assetId(comm.key)],redProfileId:redId,
            playableScenarioId:spec.aor.playableScenarioId,dataStatus:'authored-synthetic-example',recordedGame:false,engineReplay:false}}));
      }

      const supported=ratings.filter(x=>x==='supported').length;
      const criterionStatus=supported>=2?'criterion-met-in-authored-cases':supported===1?'criterion-partly-shown':'criterion-not-yet-shown';
      const behaviors=uniq(plans.map(pl=>pl.behavior));
      records.push(record({id:personaId,aorId,kind:'persona',title:displayName,
        summary:`Fictional ${role} preset for ${spec.aor.name}. Authored behaviors: ${behaviors.map(b=>BEHAVIOR_PROFILE[b].label.toLowerCase()).join('; ')}.`,
        body:`${displayName} is a fictional demo persona, not an authenticated user and not modeled on any real person. The profile is an authored preset describing decision behaviors shown in three authored cases; it is not inferred skill and not a personality description. Strengths: ${behaviors.map(b=>BEHAVIOR_PROFILE[b].strength).join(' ')} Limitations: ${behaviors.map(b=>BEHAVIOR_PROFILE[b].limitation).join(' ')} Criterion status (${criterionStatus}) counts reasoning reviews rated supported; it is not a mastery judgment.`,
        roles:[role],tags:[...aorTag,'persona',role,'synthetic',...behaviors],provenance:'synthetic',sourceIds:[],
        links:[link('belongs-to',orgId(role)),...uniq(plans.map(pl=>id('lesson',pl.lesson))).map(l=>link('uses',l))],personaId,
        fields:{displayName,role,organizationId:orgId(role),profileBasis:'authored-preset',inferredSkill:false,fictional:true,authenticatedUser:false,
          caseIds:plans.map(pl=>caseIdOf(pl.slot)),contrastCaseIds:[caseIdOf(1),caseIdOf(2)],focusLessonId:id('lesson',plans[0].lesson),
          strengths:behaviors.map(b=>BEHAVIOR_PROFILE[b].strength),limitations:behaviors.map(b=>BEHAVIOR_PROFILE[b].limitation),
          criterionStatus,criterionRule:'Reasoning review rated supported in at least 2 of 3 authored cases. Preset label, not mastery or measured skill.',
          supportedReasoningCases:supported}}));
    });
  }

  return {schema:'replay.preset-catalog/1',version:PRESET_CATALOG_VERSION,seed:PRESET_CATALOG_SEED,notice:PRESET_CATALOG_NOTICE,
    aors,sources:CATALOG_SOURCES.map(s=>({...s})),records};
}
