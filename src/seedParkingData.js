require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const buildings = [
  // ── Academic buildings ───────────────────────────────────────────────────
  { name: 'Hill Center', campus: 'Busch', lat: 40.5226, lng: -74.4602, is_dorm: false },
  { name: 'Busch Student Center', campus: 'Busch', lat: 40.5236, lng: -74.4607, is_dorm: false },
  { name: 'Allison Road Classroom Building', campus: 'Busch', lat: 40.5219, lng: -74.4614, is_dorm: false },
  { name: 'Science and Engineering Resource Center', campus: 'Busch', lat: 40.5224, lng: -74.4634, is_dorm: false },
  { name: 'Werblin Recreation Center', campus: 'Busch', lat: 40.5294, lng: -74.4636, is_dorm: false },
  { name: 'Livingston Student Center', campus: 'Livingston', lat: 40.5235, lng: -74.4392, is_dorm: false },
  { name: 'Livingston Recreation Center', campus: 'Livingston', lat: 40.5223, lng: -74.4407, is_dorm: false },
  { name: 'College Ave Student Center', campus: 'College Ave', lat: 40.5008, lng: -74.4474, is_dorm: false },
  { name: 'Alexander Library', campus: 'College Ave', lat: 40.5013, lng: -74.4467, is_dorm: false },
  { name: 'Scott Hall', campus: 'College Ave', lat: 40.5009, lng: -74.4459, is_dorm: false },
  { name: 'College Ave Gym', campus: 'College Ave', lat: 40.5023, lng: -74.4470, is_dorm: false },
  { name: 'Brower Commons', campus: 'College Ave', lat: 40.5018, lng: -74.4480, is_dorm: false },
  { name: 'Cook Campus Center', campus: 'Cook', lat: 40.4756, lng: -74.4385, is_dorm: false },
  { name: 'Douglass Student Center', campus: 'Douglass', lat: 40.4789, lng: -74.4339, is_dorm: false },
  { name: 'Douglass Library', campus: 'Douglass', lat: 40.4795, lng: -74.4318, is_dorm: false },

  // ── College Ave dorms ────────────────────────────────────────────────────
  { name: 'Brett Hall', campus: 'College Ave', lat: 40.5017, lng: -74.4443, is_dorm: true },
  { name: 'Campbell Hall', campus: 'College Ave', lat: 40.5003, lng: -74.4456, is_dorm: true },
  { name: 'Clothier Hall', campus: 'College Ave', lat: 40.4997, lng: -74.4461, is_dorm: true },
  { name: 'Demarest Hall', campus: 'College Ave', lat: 40.5021, lng: -74.4457, is_dorm: true },
  { name: 'Frelinghuysen Hall', campus: 'College Ave', lat: 40.5002, lng: -74.4471, is_dorm: true },
  { name: 'Hardenbergh Hall', campus: 'College Ave', lat: 40.5006, lng: -74.4466, is_dorm: true },
  { name: 'Hegeman Hall', campus: 'College Ave', lat: 40.5011, lng: -74.4448, is_dorm: true },
  { name: 'Honors College', campus: 'College Ave', lat: 40.5028, lng: -74.4463, is_dorm: true },
  { name: 'Leupp Hall', campus: 'College Ave', lat: 40.5009, lng: -74.4451, is_dorm: true },
  { name: 'Mettler Hall', campus: 'College Ave', lat: 40.5014, lng: -74.4455, is_dorm: true },
  { name: 'Pell Hall', campus: 'College Ave', lat: 40.5016, lng: -74.4449, is_dorm: true },
  { name: 'Sojourner Truth Apartments', campus: 'College Ave', lat: 40.5024, lng: -74.4432, is_dorm: true },
  { name: 'Stonier Hall', campus: 'College Ave', lat: 40.4999, lng: -74.4458, is_dorm: true },
  { name: 'Tinsley Hall', campus: 'College Ave', lat: 40.5019, lng: -74.4445, is_dorm: true },
  { name: 'University Center at Easton Avenue', campus: 'College Ave', lat: 40.5031, lng: -74.4428, is_dorm: true },
  { name: 'Wessels Hall', campus: 'College Ave', lat: 40.5013, lng: -74.4452, is_dorm: true },

  // ── Busch dorms ──────────────────────────────────────────────────────────
  { name: 'Allen Hall', campus: 'Busch', lat: 40.5224, lng: -74.4658, is_dorm: true },
  { name: 'Barr Hall', campus: 'Busch', lat: 40.5221, lng: -74.4662, is_dorm: true },
  { name: 'Mattia Hall', campus: 'Busch', lat: 40.5226, lng: -74.4655, is_dorm: true },
  { name: 'Metzger Hall', campus: 'Busch', lat: 40.5228, lng: -74.4660, is_dorm: true },
  { name: 'BEST Hall', campus: 'Busch', lat: 40.5270, lng: -74.4670, is_dorm: true },
  { name: 'Crosby Hall', campus: 'Busch', lat: 40.5265, lng: -74.4668, is_dorm: true },
  { name: 'Judson Hall', campus: 'Busch', lat: 40.5268, lng: -74.4663, is_dorm: true },
  { name: 'McCormick Hall', campus: 'Busch', lat: 40.5272, lng: -74.4665, is_dorm: true },
  { name: 'Morrow Hall', campus: 'Busch', lat: 40.5275, lng: -74.4672, is_dorm: true },
  { name: 'Thomas Hall', campus: 'Busch', lat: 40.5267, lng: -74.4675, is_dorm: true },
  { name: 'Winkler Hall', campus: 'Busch', lat: 40.5273, lng: -74.4669, is_dorm: true },
  { name: 'Richardson Apartments', campus: 'Busch', lat: 40.5258, lng: -74.4580, is_dorm: true },
  { name: 'Nichols Apartments', campus: 'Busch', lat: 40.5255, lng: -74.4575, is_dorm: true },
  { name: 'Silvers Apartments', campus: 'Busch', lat: 40.5252, lng: -74.4578, is_dorm: true },
  { name: 'Marvin Apartments', campus: 'Busch', lat: 40.5204, lng: -74.4544, is_dorm: true },
  { name: 'Buell Apartments', campus: 'Busch', lat: 40.5249, lng: -74.4572, is_dorm: true },
  { name: 'Johnson Apartments', campus: 'Busch', lat: 40.5278, lng: -74.4648, is_dorm: true },

  // ── Livingston dorms ─────────────────────────────────────────────────────
  { name: 'Lynton Towers North', campus: 'Livingston', lat: 40.5248, lng: -74.4368, is_dorm: true },
  { name: 'Lynton Towers South', campus: 'Livingston', lat: 40.5244, lng: -74.4370, is_dorm: true },
  { name: 'Livingston Quad I', campus: 'Livingston', lat: 40.5238, lng: -74.4385, is_dorm: true },
  { name: 'Livingston Quad II', campus: 'Livingston', lat: 40.5234, lng: -74.4380, is_dorm: true },
  { name: 'Livingston Quad III', campus: 'Livingston', lat: 40.5230, lng: -74.4376, is_dorm: true },
  { name: 'Livingston Apartments A', campus: 'Livingston', lat: 40.5220, lng: -74.4328, is_dorm: true },
  { name: 'Livingston Apartments B', campus: 'Livingston', lat: 40.5218, lng: -74.4325, is_dorm: true },
  { name: 'Livingston Apartments C', campus: 'Livingston', lat: 40.5216, lng: -74.4322, is_dorm: true },

  // ── Cook dorms ───────────────────────────────────────────────────────────
  { name: 'Helyar House', campus: 'Cook', lat: 40.4718, lng: -74.4355, is_dorm: true },
  { name: 'Lippincott Hall', campus: 'Cook', lat: 40.4812, lng: -74.4304, is_dorm: true },
  { name: 'Nicholas Hall', campus: 'Cook', lat: 40.4808, lng: -74.4300, is_dorm: true },
  { name: 'Perry Hall', campus: 'Cook', lat: 40.4775, lng: -74.4320, is_dorm: true },
  { name: 'Voorhees Hall', campus: 'Cook', lat: 40.4772, lng: -74.4325, is_dorm: true },
  { name: 'Newell Apartments', campus: 'Cook', lat: 40.4780, lng: -74.4298, is_dorm: true },
  { name: 'Starkey Apartments', campus: 'Cook', lat: 40.4778, lng: -74.4295, is_dorm: true },

  // ── Douglass dorms ───────────────────────────────────────────────────────
  { name: 'Bunting-Cobb Hall', campus: 'Douglass', lat: 40.4842, lng: -74.4328, is_dorm: true },
  { name: 'Katzenbach Hall', campus: 'Douglass', lat: 40.4828, lng: -74.4316, is_dorm: true },
  { name: 'Jameson Hall', campus: 'Douglass', lat: 40.4838, lng: -74.4365, is_dorm: true },
  { name: 'New Gibbons Hall', campus: 'Douglass', lat: 40.4858, lng: -74.4323, is_dorm: true },
  { name: 'Woodbury Hall', campus: 'Douglass', lat: 40.4805, lng: -74.4321, is_dorm: true },
  { name: 'Henderson Apartments', campus: 'Douglass', lat: 40.4812, lng: -74.4276, is_dorm: true },
];

const lots = [
  // ── BUSCH commuter primary (6AM-12AM Mon-Sun) ────────────────────────────
  { id: 'lot613', name: 'Lot 613 / Stadium West', campus: 'Busch', lat: 40.513690, lng: -74.467160, lot_type: 'commuter', access_type: 'primary' },
  { id: 'lot602', name: 'Lot 602', campus: 'Busch', lat: 40.526279, lng: -74.464663, lot_type: 'commuter', access_type: 'primary' },

  // ── BUSCH commuter flex (5PM-12AM Mon-Fri, 6AM-12AM Sat-Sun) ────────────
  { id: 'lot48', name: 'Lot 48', campus: 'Busch', lat: 40.515064, lng: -74.460720, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot50', name: 'Lot 50', campus: 'Busch', lat: 40.521857, lng: -74.472582, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot51', name: 'Lot 51', campus: 'Busch', lat: 40.524342, lng: -74.457523, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot51b', name: 'Lot 51B', campus: 'Busch', lat: 40.526140, lng: -74.458538, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot53a', name: 'Lot 53A', campus: 'Busch', lat: 40.520561, lng: -74.463178, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot54', name: 'Lot 54', campus: 'Busch', lat: 40.525544, lng: -74.461417, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot55', name: 'Gated Lot 55', campus: 'Busch', lat: 40.525386, lng: -74.465712, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot58', name: 'Lot 58', campus: 'Busch', lat: 40.525626, lng: -74.466455, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot58a', name: 'Lot 58A', campus: 'Busch', lat: 40.525941, lng: -74.466778, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot59', name: 'Lot 59', campus: 'Busch', lat: 40.522617, lng: -74.459347, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot60a', name: 'Lot 60A', campus: 'Busch', lat: 40.521269, lng: -74.459917, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot60b', name: 'Lot 60B', campus: 'Busch', lat: 40.521570, lng: -74.459269, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot61', name: 'Lot 61', campus: 'Busch', lat: 40.526140, lng: -74.458530, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot63', name: 'Lot 63', campus: 'Busch', lat: 40.523605, lng: -74.454567, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot63b', name: 'Lot 63B', campus: 'Busch', lat: 40.523503, lng: -74.453972, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot64', name: 'Lot 64', campus: 'Busch', lat: 40.520600, lng: -74.460349, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot66b', name: 'Lot 66B', campus: 'Busch', lat: 40.521345, lng: -74.454421, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot67', name: 'Lot 67', campus: 'Busch', lat: 40.521351, lng: -74.457952, lot_type: 'commuter', access_type: 'flex' },

  // ── BUSCH resident home lots (24/7) ──────────────────────────────────────
  { id: 'lot58b', name: 'Lot 58B', campus: 'Busch', lat: 40.526212, lng: -74.467347, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot58c', name: 'Lot 58C', campus: 'Busch', lat: 40.527438, lng: -74.468021, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot58d', name: 'Lot 58D', campus: 'Busch', lat: 40.528421, lng: -74.466665, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot62', name: 'Lot 62', campus: 'Busch', lat: 40.526555, lng: -74.457086, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot65a', name: 'Lot 65A', campus: 'Busch', lat: 40.519224, lng: -74.455648, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot65d', name: 'Lot 65D', campus: 'Busch', lat: 40.519609, lng: -74.456953, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot66a', name: 'Lot 66A', campus: 'Busch', lat: 40.521250, lng: -74.455506, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot67a', name: 'Lot 67A', campus: 'Busch', lat: 40.520247, lng: -74.456886, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot603', name: 'Johnson Apartment Lot 603', campus: 'Busch', lat: 40.527884, lng: -74.465236, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot604', name: 'Johnson Apartment Lot 604', campus: 'Busch', lat: 40.527029, lng: -74.463326, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot605', name: 'Johnson Apartment Lot 605', campus: 'Busch', lat: 40.527613, lng: -74.464163, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot606', name: 'Johnson Apartment Lot 606', campus: 'Busch', lat: 40.527315, lng: -74.466607, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot623', name: 'Lot 623 / Marvin Apts', campus: 'Busch', lat: 40.520428, lng: -74.454358, lot_type: 'resident', access_type: 'primary' },

  // ── COLLEGE AVE commuter primary (6AM-12AM Mon-Sun) ──────────────────────
  { id: 'lot20', name: 'Lot 20', campus: 'College Ave', lat: 40.505027, lng: -74.450232, lot_type: 'commuter', access_type: 'primary' },
  { id: 'lot26', name: 'Lot 26', campus: 'College Ave', lat: 40.501856, lng: -74.452563, lot_type: 'commuter', access_type: 'primary' },
  { id: 'lot30', name: 'Lot 30', campus: 'College Ave', lat: 40.502703, lng: -74.453390, lot_type: 'commuter', access_type: 'primary' },
  { id: 'lot505', name: 'Lot 505 / CAC Parking Deck', campus: 'College Ave', lat: 40.504400, lng: -74.451367, lot_type: 'commuter', access_type: 'primary' },

  // ── COLLEGE AVE commuter flex ─────────────────────────────────────────────
  { id: 'lot11nb', name: 'Lot 11 NB', campus: 'College Ave', lat: 40.500004, lng: -74.450368, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot16', name: 'Gated Lot 16', campus: 'College Ave', lat: 40.501008, lng: -74.446344, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot32', name: 'Lot 32', campus: 'College Ave', lat: 40.504025, lng: -74.453748, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot33', name: 'Lot 33', campus: 'College Ave', lat: 40.505709, lng: -74.453377, lot_type: 'commuter', access_type: 'flex' },
  { id: 'pubsafety', name: 'Public Safety Building Deck', campus: 'College Ave', lat: 40.488359, lng: -74.439383, lot_type: 'commuter', access_type: 'flex' },

  // ── COOK commuter primary (6AM-12AM Mon-Sun) ──────────────────────────────
  { id: 'lot98a', name: 'Lot 98A', campus: 'Cook', lat: 40.479058, lng: -74.438174, lot_type: 'commuter', access_type: 'primary' },
  { id: 'lot98b', name: 'Lot 98B', campus: 'Cook', lat: 40.477393, lng: -74.437665, lot_type: 'commuter', access_type: 'primary' },
  { id: 'lot99c', name: 'Lot 99C', campus: 'Cook', lat: 40.477735, lng: -74.428455, lot_type: 'commuter', access_type: 'primary' },
  { id: 'lot99d', name: 'Lot 99D', campus: 'Cook', lat: 40.476380, lng: -74.428880, lot_type: 'commuter', access_type: 'primary' },

  // ── COOK commuter flex ────────────────────────────────────────────────────
  { id: 'lot94', name: 'Lot 94', campus: 'Cook', lat: 40.472408, lng: -74.436712, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot95', name: 'Lot 95', campus: 'Cook', lat: 40.479616, lng: -74.444294, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot97', name: 'Lot 97', campus: 'Cook', lat: 40.478667, lng: -74.435593, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot805', name: 'Lot 805 / Lipman Drive', campus: 'Cook', lat: 40.480831, lng: -74.438043, lot_type: 'commuter', access_type: 'flex' },

  // ── COOK resident home lots (24/7) ────────────────────────────────────────
  { id: 'lot99', name: 'Lot 99', campus: 'Cook', lat: 40.478365, lng: -74.431042, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot99a', name: 'Lot 99A', campus: 'Cook', lat: 40.477248, lng: -74.432086, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot99b', name: 'Lot 99B', campus: 'Cook', lat: 40.477499, lng: -74.429745, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot99c_res', name: 'Lot 99C (Resident)', campus: 'Cook', lat: 40.477735, lng: -74.428455, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot99d_res', name: 'Lot 99D (Resident)', campus: 'Cook', lat: 40.476380, lng: -74.428880, lot_type: 'resident', access_type: 'primary' },
  { id: 'helyar_lot', name: 'Helyar House Lot', campus: 'Cook', lat: 40.471835, lng: -74.435493, lot_type: 'resident', access_type: 'primary' },

  // ── DOUGLASS commuter primary (6AM-12AM Mon-Sun) ──────────────────────────
  { id: 'lot79', name: 'Lot 79', campus: 'Douglass', lat: 40.484311, lng: -74.433587, lot_type: 'commuter', access_type: 'primary' },
  { id: 'douglassdeck', name: 'Douglas Deck', campus: 'Douglass', lat: 40.483816, lng: -74.436531, lot_type: 'commuter', access_type: 'primary' },

  // ── DOUGLASS commuter flex ────────────────────────────────────────────────
  { id: 'lot70', name: 'Lot 70', campus: 'Douglass', lat: 40.483910, lng: -74.437109, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot71a', name: 'Lot 71A', campus: 'Douglass', lat: 40.481457, lng: -74.428695, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot75', name: 'Lot 75', campus: 'Douglass', lat: 40.481664, lng: -74.432283, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot79a', name: 'Gated Lot 79A', campus: 'Douglass', lat: 40.484769, lng: -74.433409, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot82', name: 'Lot 82', campus: 'Douglass', lat: 40.483374, lng: -74.430910, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot83', name: 'Lot 83', campus: 'Douglass', lat: 40.477116, lng: -74.426450, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot84', name: 'Lot 84', campus: 'Douglass', lat: 40.478708, lng: -74.424183, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot86', name: 'Lot 86', campus: 'Douglass', lat: 40.483006, lng: -74.438303, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot88', name: 'Lot 88', campus: 'Douglass', lat: 40.479982, lng: -74.428995, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot96', name: 'Lot 96', campus: 'Douglass', lat: 40.480415, lng: -74.427569, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot96a', name: 'Lot 96A', campus: 'Douglass', lat: 40.480096, lng: -74.426460, lot_type: 'commuter', access_type: 'flex' },

  // ── DOUGLASS resident home lots (24/7) ────────────────────────────────────
  { id: 'lot76', name: 'Lot 76', campus: 'Douglass', lat: 40.480539, lng: -74.432074, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot711', name: 'Lot 711 / Lippincott', campus: 'Douglass', lat: 40.481163, lng: -74.430413, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot712', name: 'Lot 712 / Katzenbach', campus: 'Douglass', lat: 40.482763, lng: -74.431567, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot74a', name: 'Lot 74A', campus: 'Douglass', lat: 40.485852, lng: -74.432333, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot80', name: 'Lot 80', campus: 'Douglass', lat: 40.481201, lng: -74.427552, lot_type: 'resident', access_type: 'primary' },

  // ── LIVINGSTON commuter primary (6AM-12AM Mon-Sun) ────────────────────────
  { id: 'lot915', name: 'Lot 915 / Yellow Lot', campus: 'Livingston', lat: 40.527783, lng: -74.438171, lot_type: 'commuter', access_type: 'primary' },

  // ── LIVINGSTON commuter flex ──────────────────────────────────────────────
  { id: 'lot107', name: 'Lot 107', campus: 'Livingston', lat: 40.523998, lng: -74.431292, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot108', name: 'Lot 108', campus: 'Livingston', lat: 40.514024, lng: -74.434529, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot111', name: 'Lot 111', campus: 'Livingston', lat: 40.515496, lng: -74.433198, lot_type: 'commuter', access_type: 'flex' },
  { id: 'lot916', name: 'Lot 916 / Green Lot', campus: 'Livingston', lat: 40.526238, lng: -74.440195, lot_type: 'commuter', access_type: 'flex' },

  // ── LIVINGSTON resident home lots (24/7) ──────────────────────────────────
  { id: 'lot103', name: 'Lot 103', campus: 'Livingston', lat: 40.520519, lng: -74.432479, lot_type: 'resident', access_type: 'primary' },
  { id: 'lot105', name: 'Lot 105', campus: 'Livingston', lat: 40.524333, lng: -74.433753, lot_type: 'resident', access_type: 'primary' },
];

const permitRules = [
  { permit_type: 'primary', days: 'Mon-Sun', start_time: '06:00', end_time: '23:59', lot_types: ['commuter'], same_campus_only: true, excluded_campuses: [] },
  { permit_type: 'secondary', days: 'Mon-Fri', start_time: '10:00', end_time: '23:59', lot_types: ['commuter'], same_campus_only: true, excluded_campuses: ['Busch', 'College Ave'] },
  { permit_type: 'flex', days: 'Mon-Fri', start_time: '17:00', end_time: '23:59', lot_types: ['commuter'], same_campus_only: false, excluded_campuses: [] },
  { permit_type: 'resident', days: 'Mon-Sun', start_time: '00:00', end_time: '23:59', lot_types: ['resident'], same_campus_only: true, excluded_campuses: [] },
  { permit_type: 'residentFlex', days: 'Mon-Fri', start_time: '17:00', end_time: '23:59', lot_types: ['commuter'], same_campus_only: false, excluded_campuses: [] },
];

async function seed() {
  console.log('Clearing old data...');
  await supabase.from('app_parking_lots').delete().neq('id', 'KEEP_ALL');
  await supabase.from('app_parking_buildings').delete().neq('id', -1);

  console.log('Seeding buildings...');
  const { error: bErr } = await supabase.from('app_parking_buildings').upsert(buildings, { onConflict: 'name' });
  if (bErr) console.error('Buildings error:', bErr.message);
  else console.log(`Seeded ${buildings.length} buildings.`);

  console.log('Seeding lots...');
  const { error: lErr } = await supabase.from('app_parking_lots').upsert(lots, { onConflict: 'id' });
  if (lErr) console.error('Lots error:', lErr.message);
  else console.log(`Seeded ${lots.length} lots.`);

  console.log('Seeding permit rules...');
  const { error: pErr } = await supabase.from('app_parking_permit_rules').upsert(permitRules, { onConflict: 'permit_type' });
  if (pErr) console.error('Permit rules error:', pErr.message);
  else console.log(`Seeded ${permitRules.length} permit rules.`);

  console.log('Done.');
  process.exit(0);
}

seed();