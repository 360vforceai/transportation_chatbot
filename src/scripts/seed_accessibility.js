// seed_accessibility.js
// Run with: node scripts/seed_accessibility.js
// Seeds the Supabase `accessibility` table with structured data from:
//   - RADR: https://radr.rutgers.edu/resource/visitors-disabilities
//   - RADR: https://radr.rutgers.edu/resource/transportation-and-parking
//   - DOTS: https://ipo.rutgers.edu/dots/buses/nb
//   - ODS:  https://ods.rutgers.edu/students/housing-parking-dining/accessible-transportation-and-parking

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Structured accessibility data ────────────────────────────────────────────
// Format: { category, topic, campus, content, source_url }
// content is what gets embedded — written like a natural-language answer
// so vector search returns the most relevant record to a user question.

const records = [

  // ── CAMPUS BUSES — GENERAL ────────────────────────────────────────────────
  {
    category: 'transportation',
    topic: 'accessible_buses_general',
    campus: 'all',
    content: `All Rutgers campus buses are ADA accessible and wheelchair accessible. Every bus is equipped with either low-entrance steps or mechanical lift platforms to accommodate riders with mobility impairments, including wheelchair users. Accessible bus service is available to all members of the Rutgers University community at no extra charge — students, faculty, staff, and visitors. You do not need to register or pre-arrange to use the accessible features on standard intercampus buses. Just board at any stop; the driver will deploy the lift or ramp. Source: DOTS, RADR.`,
    source_url: 'https://ipo.rutgers.edu/dots/buses/nb'
  },

  // ── NEW BRUNSWICK — BUS SERVICE ───────────────────────────────────────────
  {
    category: 'transportation',
    topic: 'accessible_buses_new_brunswick',
    campus: 'new_brunswick',
    content: `Rutgers New Brunswick campus buses are fully ADA accessible. All intercampus buses serving College Avenue, Busch, Livingston, and Cook/Douglass campuses have low-floor entry and/or mechanical wheelchair lift platforms. Buses run 7 days a week during the academic year, typically from 6 AM to 2 AM on weekdays. You can track buses in real time at rutgers.transloc.com or via the TransLoc app (search "Rutgers"). The Knight Mover late-night shuttle runs after regular bus service ends and is also accessible — call the Knight Mover number to request a pickup. For students who cannot use standard bus service due to a disability, Rutgers offers a paratransit van service; contact DOTS to apply. Phone: 848-932-7744. Website: ipo.rutgers.edu/dots`,
    source_url: 'https://ipo.rutgers.edu/dots/buses/nb'
  },

  // ── NEW BRUNSWICK — PARATRANSIT ───────────────────────────────────────────
  {
    category: 'transportation',
    topic: 'paratransit_new_brunswick',
    campus: 'new_brunswick',
    content: `Rutgers New Brunswick offers a paratransit van service for students with disabilities who cannot use the regular campus bus system. This is an on-demand accessible van service. To be considered, students must apply through DOTS (Department of Transportation Services). Contact DOTS at dotshelp.rutgers.edu or call 848-932-7744. You must have a documented disability through ODS or RADR to qualify. The service is designed for temporary or permanent mobility impairments that prevent standard bus use.`,
    source_url: 'https://ods.rutgers.edu/students/housing-parking-dining/accessible-transportation-and-parking'
  },

  // ── NEWARK — BUS SERVICE ──────────────────────────────────────────────────
  {
    category: 'transportation',
    topic: 'accessible_buses_newark',
    campus: 'newark',
    content: `Rutgers Newark campus buses use ADA-accessible, lift-equipped buses on all routes. The Newark Campus Bus/Shuttle Service connects Rutgers University Newark, NJIT, Rutgers Biomedical and Health Sciences (RBHS) Newark Campus, University Hospital, Essex County College, and Newark Broad Street NJ Transit station. The service is free for anyone affiliated with Rutgers Newark, Rutgers NB, Camden, NJIT, Essex County College, RBHS, or University Hospital. The "Campus Connect" route links all Newark-area institutions. Track buses at ipo.rutgers.edu/dots/buses/newark. For inquiries: dotshelp.rutgers.edu`,
    source_url: 'https://ipo.rutgers.edu/transportation/buses/newark'
  },

  // ── CAMDEN — BUS SERVICE ──────────────────────────────────────────────────
  {
    category: 'transportation',
    topic: 'accessible_buses_camden',
    campus: 'camden',
    content: `Rutgers Camden Shuttle serves City Lots 15 & 16, the Law School, Nursing & Science Building, and Business & Science Building in a loop. The shuttle is ADA accessible. During Fall & Spring semesters it runs weekdays 7 AM–10 PM Mon–Thu and 7 AM–7 PM Fri. Summer weekdays it runs 7 AM–7 PM Mon–Thu. No weekend, holiday, or semester-break service. Track live GPS at ipo.rutgers.edu/dots/buses-camden.`,
    source_url: 'https://ipo.rutgers.edu/dots/buses-camden'
  },

  // ── ACCESSIBLE PARKING — GENERAL ─────────────────────────────────────────
  {
    category: 'parking',
    topic: 'accessible_parking_general',
    campus: 'all',
    content: `All Rutgers campuses have accessible parking (ADA parking). To use accessible parking at Rutgers, you need BOTH a valid state-issued disability placard/ID AND a valid Rutgers parking permit. The state placard alone is not sufficient on campus. Here's how to get set up: (1) Obtain a Rutgers parking permit through ipo.rutgers.edu/dots — the permit type depends on your affiliation (student/faculty/staff/visitor) and time on campus. (2) Submit a copy of your state disability placard to DOTS via dotshelp.rutgers.edu → Get Help → Permitting. For permanent disability: submit front and back of your state Permanently Disabled ID and placard. For temporary disability: submit front and back of your Temporary Disabled ID; coverage matches placard expiration date. If you don't have a state placard, ask your physician to submit a Certification for Medical Need Form (available at rutgers.ca1.qualtrics.com) and submit an Additional Parking Request Form. DOTS Help: dotshelp.rutgers.edu | Phone: 848-932-7744`,
    source_url: 'https://radr.rutgers.edu/resource/transportation-and-parking'
  },

  // ── ACCESSIBLE PARKING — VISITORS ────────────────────────────────────────
  {
    category: 'parking',
    topic: 'accessible_parking_visitors',
    campus: 'all',
    content: `Visitors with disabilities to any Rutgers campus must obtain a visitor parking permit in addition to their state disability placard to park in accessible spaces. Visitor parking information and permits are available at ipo.rutgers.edu/dots/visitor-parking. For accessible parking at Rutgers football games at High Point Solutions Stadium, ADA shuttle services are available. Contact the stadium for details at scarletknights.com/sports/2017/6/28/guests-with-a-disability.aspx. Questions: DOTS at 848-932-7744 or dotshelp.rutgers.edu`,
    source_url: 'https://radr.rutgers.edu/resource/visitors-disabilities'
  },

  // ── ACCESSIBLE ENTRANCES & FACILITIES ────────────────────────────────────
  {
    category: 'facilities',
    topic: 'accessible_entrances_and_barriers',
    campus: 'all',
    content: `Rutgers is committed to accessible entrances and facilities across all campuses. If you encounter a barrier — broken elevator, inaccessible entrance, broken door opener, broken outdoor lights, broken pavement, or a locked building — contact Rutgers Facilities immediately. Facilities Phone: 848-445-1234. Website: ipo.rutgers.edu/facilities. For accessibility barriers specifically involving transportation or parking (bus problems, inaccessible parking, parking questions), contact DOTS: 848-932-7744 or dotshelp.rutgers.edu. For emergency situations — locked building, accessible parking blocked, evacuation support — contact RUPD: Emergency 9-1-1 | Non-emergency 732-932-7211. Students can also report accessibility barriers using the Barrier Buster tool at radr.rutgers.edu/resource/barrier-buster-information`,
    source_url: 'https://radr.rutgers.edu/resource/visitors-disabilities'
  },

  // ── REASONABLE ACCOMMODATIONS FOR EVENTS/VISITORS ────────────────────────
  {
    category: 'accommodations',
    topic: 'event_visitor_accommodations',
    campus: 'all',
    content: `If you need accessibility accommodations for a Rutgers event, program, or service — such as an ASL interpreter, CART (Computer Aided Realtime Captioning), accessible technology, or other needs — contact the host/organizer of the event in advance. Some accommodations require planning time to arrange. If the event department cannot accommodate you, they will work with Rutgers Access and Disability Resources (RADR). RADR contact: radr.rutgers.edu/contact-us. For concerns or to report an accessibility barrier, use the University Compliance Hotline: 833-RU-ETHICS (available 24/7 anonymously) or visit helpline.rutgers.edu.`,
    source_url: 'https://radr.rutgers.edu/resource/visitors-disabilities'
  },

  // ── RADR — STUDENT REGISTRATION ──────────────────────────────────────────
  {
    category: 'accommodations',
    topic: 'radr_student_registration',
    campus: 'all',
    content: `Rutgers students with disabilities who need academic or transportation accommodations should register with RADR (Rutgers Access and Disability Resources) and their campus Office of Disability Services (ODS). RADR coordinates services across all Rutgers campuses. Services available include: assistive technology, accessible course content, sign language interpreting, CART captioning, audio description, paratransit van referrals, accessible parking permits, and housing accommodations. To register: visit radr.rutgers.edu or your campus ODS office. New Brunswick ODS: ods.rutgers.edu. You will need documentation of your disability from a qualified professional. Once registered, you receive a Letter of Accommodations you can share with professors and departments. RADR website: radr.rutgers.edu`,
    source_url: 'https://radr.rutgers.edu/about-us'
  },

  // ── NJ TRANSIT STUDENT DISCOUNT ──────────────────────────────────────────
  {
    category: 'transportation',
    topic: 'nj_transit_student_discount',
    campus: 'all',
    content: `Full-time Rutgers students can get discounted NJ Transit monthly passes for rail, bus, or light rail. The NJ Transit Student Pass offers reduced fares for commuting students. Information is available at njtransit.com or through the NJ Transit app. Rutgers University-Newark full-time students can sign up for an additional transit discount through the Newark campus. For inter-campus travel between New Brunswick, Newark, and Camden, use the NJ Transit Northeast Corridor train (New Brunswick ↔ Newark) or River Line (Trenton ↔ Camden connection). NJ Transit trains are ADA accessible with accessible seating, boarding assistance, and accessible station facilities at major stations.`,
    source_url: 'https://ipo.rutgers.edu/transportation/buses/newark'
  },

  // ── KNIGHT MOVER LATE NIGHT ───────────────────────────────────────────────
  {
    category: 'transportation',
    topic: 'knight_mover_late_night',
    campus: 'new_brunswick',
    content: `The Knight Mover is Rutgers New Brunswick's late-night accessible shuttle service, running after the regular intercampus bus system stops for the night. It provides on-demand transportation within and between all Rutgers New Brunswick and Piscataway campuses. The Knight Mover is ADA accessible. To request a ride, call the Knight Mover phone number (listed on the DOTS website at ipo.rutgers.edu/dots). It is especially useful for students with disabilities who need safe and accessible transportation late at night when regular bus service is not running.`,
    source_url: 'https://ipo.rutgers.edu/dots/buses/nb'
  },

  // ── NEW BRUNSWICK STATION ACCESSIBILITY (NJ TRANSIT) ─────────────────────
  {
    category: 'transportation',
    topic: 'new_brunswick_nj_transit_station',
    campus: 'new_brunswick',
    content: `New Brunswick NJ Transit Train Station is accessible and serves as the main transit hub for students commuting to/from Rutgers New Brunswick. The station is on the Northeast Corridor (NEC) line with frequent service to Newark Penn Station, New York Penn Station, and Trenton. The station has accessible platforms and elevator access. From the station, Rutgers campus buses connect to all campuses. Students with disabilities can board NJ Transit trains here with accessible car options; contact NJ Transit at 1-800-772-2222 for specific accommodation needs like boarding assistance. For real-time departures from New Brunswick Station, use NJ Transit DepartureVision at njtransit.com or the NJ Transit app.`,
    source_url: 'https://www.njtransit.com'
  },

  // ── CONTACT QUICK REFERENCE ───────────────────────────────────────────────
  {
    category: 'contacts',
    topic: 'accessibility_contacts',
    campus: 'all',
    content: `Quick contact reference for Rutgers accessibility and transportation services:
- DOTS (Transportation & Parking): 848-932-7744 | dotshelp.rutgers.edu | ipo.rutgers.edu/dots
- RADR (Disability Resources): radr.rutgers.edu | accessibility@rutgers.edu
- ODS New Brunswick: ods.rutgers.edu | for housing/parking/transportation accommodations
- Rutgers Facilities (broken elevators, entrances, lights): 848-445-1234 | ipo.rutgers.edu/facilities
- RUPD Non-Emergency: 732-932-7211 | Emergency: 9-1-1
- Barrier Reporter: radr.rutgers.edu/resource/barrier-buster-information
- Certification for Medical Need Form: rutgers.ca1.qualtrics.com/jfe/form/SV_1U0bLzQFwSy8Fz7
- Additional Parking Request Form: rutgers.ca1.qualtrics.com/jfe/form/SV_8qBGI9kkjwRv7vf`,
    source_url: 'https://radr.rutgers.edu/resource/visitors-disabilities'
  },
];

// ─── Embed + insert ────────────────────────────────────────────────────────────

async function embedText(text) {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return res.data[0].embedding;
}

async function seed() {
  console.log(`Seeding ${records.length} accessibility records...\n`);
  let success = 0;
  let failed = 0;

  for (const record of records) {
    try {
      process.stdout.write(`  [${record.topic}] embedding... `);
      const embedding = await embedText(record.content);

      const { error } = await supabase.from('accessibility').upsert({
        category: record.category,
        topic: record.topic,
        campus: record.campus,
        content: record.content,
        source_url: record.source_url,
        embedding,
      }, { onConflict: 'topic' });

      if (error) throw error;
      console.log('✅');
      success++;

      // Rate limit: avoid OpenAI throttle
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.log(`❌ ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${success} inserted, ${failed} failed.`);
  if (failed > 0) console.log('Re-run the script to retry failed records.');
}

seed().catch(console.error);